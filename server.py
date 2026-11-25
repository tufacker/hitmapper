#!/usr/bin/env python3
"""Local HitMapper web server: uploads, analysis jobs, and browser assets."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from werkzeug.utils import secure_filename


APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("HITMAPPER_DATA_DIR", APP_DIR / ".runtime-data")).resolve()
PROJECTS_DIR = DATA_DIR / "projects"
MAX_UPLOAD = int(os.environ.get("HITMAPPER_MAX_UPLOAD_MB", "500")) * 1024 * 1024
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".aif", ".aiff"}
# The only files the browser needs from the app folder; nothing else is served.
APP_FILES = {"app.js", "styles.css"}
# Host names HitMapper answers to. Other web pages in the same browser can reach
# 127.0.0.1 too; checking Host (against DNS rebinding) and Origin (against
# cross-site form posts) keeps them out. Add names with HITMAPPER_ALLOWED_HOSTS
# (comma-separated) when opening HitMapper to other machines.
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"} | {
    name.strip().lower() for name in os.environ.get("HITMAPPER_ALLOWED_HOSTS", "").split(",") if name.strip()
}

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="hitmapper-analysis")
state_lock = threading.Lock()
runtime_lock = threading.Lock()
runtime_initialized = False


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path, default: dict | None = None) -> dict:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {} if default is None else default


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n")
    temporary.replace(path)


def project_dir(project_id: str) -> Path:
    if not project_id or any(character not in "0123456789abcdef" for character in project_id):
        abort(404)
    path = PROJECTS_DIR / project_id
    if not path.is_dir():
        abort(404)
    return path


def project_metadata(project_id: str) -> dict:
    return read_json(project_dir(project_id) / "project.json")


def update_project(project_id: str, **changes) -> dict:
    with state_lock:
        path = PROJECTS_DIR / project_id / "project.json"
        metadata = read_json(path)
        metadata.update(changes, updatedAt=utc_now())
        write_json(path, metadata)
        return metadata


def public_project(metadata: dict) -> dict:
    return {
        key: metadata.get(key)
        for key in ("id", "name", "filename", "status", "stage", "progress", "error", "createdAt", "updatedAt")
        if metadata.get(key) is not None
    }


def analyze_project(project_id: str) -> None:
    directory = PROJECTS_DIR / project_id
    metadata = read_json(directory / "project.json")
    source = directory / metadata["storedFilename"]
    log_path = directory / "analysis.log"
    update_project(project_id, status="analyzing", stage="Preparing audio", progress=5, error=None)
    command = [
        sys.executable,
        str(APP_DIR / "analysis_pipeline.py"),
        "--source", str(source),
        "--work", str(directory / "work"),
        "--output", str(directory / "analysis.json"),
        "--track-name", metadata["name"],
    ]
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    try:
        with log_path.open("w", buffering=1) as log:
            with subprocess.Popen(
                command,
                cwd=APP_DIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env=env,
            ) as process:
                assert process.stdout is not None
                for line in process.stdout:
                    log.write(line)
                    lower = line.lower()
                    if "separat" in lower or "demix" in lower:
                        update_project(project_id, stage="Separating instruments", progress=24)
                    elif "harmonix" in lower or "struct" in lower:
                        update_project(project_id, stage="Finding song structure", progress=48)
                    elif "chord" in lower:
                        update_project(project_id, stage="Charting chords", progress=68)
                    elif "prepared" in lower:
                        update_project(project_id, stage="Building session map", progress=92)
                return_code = process.wait()
        if return_code:
            if return_code in (-9, 137) or "SIGKILL" in log_path.read_text(errors="replace")[-4000:]:
                raise RuntimeError(
                    "The analysis was stopped by the system, usually because it ran out of memory. "
                    "Long songs need more: give Docker more memory (Docker Desktop › Settings › "
                    "Resources › Memory), then press Retry."
                )
            raise RuntimeError(f"Analyzer exited with status {return_code}")
        analysis = read_json(directory / "analysis.json")
        if not analysis.get("track"):
            raise RuntimeError("Analyzer did not create a valid song map")
        update_project(project_id, status="ready", stage="Ready", progress=100)
    except Exception as error:  # Keep the browser informed instead of losing a background exception.
        tail = ""
        if log_path.exists():
            tail = "\n".join(log_path.read_text(errors="replace").splitlines()[-12:])
        update_project(
            project_id,
            status="failed",
            stage="Analysis failed",
            progress=0,
            error=f"{error}\n{tail}".strip(),
        )


def initialize_runtime() -> None:
    """Resume unfinished work after a container or computer restart."""
    global runtime_initialized
    with runtime_lock:
        if runtime_initialized:
            return
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
        for path in PROJECTS_DIR.iterdir():
            metadata = read_json(path / "project.json") if path.is_dir() else {}
            if metadata.get("status") in {"queued", "analyzing"}:
                project_id = metadata.get("id")
                if project_id:
                    update_project(project_id, status="queued", stage="Resuming analysis", progress=max(1, metadata.get("progress", 1)))
                    executor.submit(analyze_project, project_id)
        runtime_initialized = True


def host_name(host: str) -> str:
    return (urlsplit("//" + host).hostname or "").lower()


@app.before_request
def only_this_app():
    if host_name(request.host) not in ALLOWED_HOSTS:
        abort(403)
    origin = request.headers.get("Origin")
    if request.method not in {"GET", "HEAD", "OPTIONS"} and origin and urlsplit(origin).netloc.lower() != request.host.lower():
        abort(403)


@app.before_request
def ensure_runtime():
    initialize_runtime()


@app.errorhandler(413)
def upload_too_large(_error):
    return jsonify(error=f"That file exceeds the {MAX_UPLOAD // (1024 * 1024)} MB upload limit."), 413


@app.get("/api/status")
def api_status():
    projects = []
    if PROJECTS_DIR.exists():
        for path in PROJECTS_DIR.iterdir():
            metadata = read_json(path / "project.json") if path.is_dir() else {}
            if metadata:
                projects.append(public_project(metadata))
    projects.sort(key=lambda item: item.get("createdAt", ""), reverse=True)
    current = next((item for item in projects if item.get("status") in {"queued", "analyzing"}), None)
    return jsonify(currentJob=current, projects=projects)


@app.post("/api/tracks")
def upload_track():
    uploaded = request.files.get("song")
    if uploaded is None or not uploaded.filename:
        return jsonify(error="Choose an audio file first."), 400
    # The extension and default name come from the name as given (non-Latin
    # names included); the file itself is stored under a generated name.
    given_name = Path(uploaded.filename.replace("\\", "/")).name
    extension = Path(given_name).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        return jsonify(error=f"Unsupported audio type. Use {', '.join(sorted(ALLOWED_EXTENSIONS))}."), 400
    original_name = secure_filename(given_name) or f"song{extension}"
    project_id = uuid.uuid4().hex
    directory = PROJECTS_DIR / project_id
    directory.mkdir(parents=True, exist_ok=False)
    stored_name = f"source{extension}"
    source = directory / stored_name
    display_name = (request.form.get("name") or Path(given_name).stem).strip()[:120]
    try:
        uploaded.save(source)
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(source)],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        duration = float(probe.stdout.strip())
        if not 1 <= duration <= 60 * 30:
            raise ValueError("Songs must be between 1 second and 30 minutes long.")
    except Exception as error:
        shutil.rmtree(directory, ignore_errors=True)
        return jsonify(error=f"That file could not be read as audio: {error}"), 400
    metadata = {
        "id": project_id,
        "name": display_name or "Untitled song",
        "filename": original_name,
        "storedFilename": stored_name,
        "duration": duration,
        "status": "queued",
        "stage": "Waiting to analyze",
        "progress": 1,
        "createdAt": utc_now(),
        "updatedAt": utc_now(),
    }
    write_json(directory / "project.json", metadata)
    executor.submit(analyze_project, project_id)
    return jsonify(project=public_project(metadata)), 202


@app.get("/api/jobs/<project_id>")
def job_status(project_id: str):
    return jsonify(project=public_project(project_metadata(project_id)))


@app.post("/api/projects/<project_id>/retry")
def retry_project(project_id: str):
    metadata = project_metadata(project_id)
    if metadata.get("status") in {"queued", "analyzing"}:
        return jsonify(project=public_project(metadata)), 202
    if metadata.get("status") != "failed":
        return jsonify(error="Only failed analyses can be retried."), 409
    metadata = update_project(
        project_id,
        status="queued",
        stage="Waiting to retry",
        progress=1,
        error=None,
    )
    executor.submit(analyze_project, project_id)
    return jsonify(project=public_project(metadata)), 202


def project_file(project_id: str, kind: str):
    directory = project_dir(project_id)
    metadata = read_json(directory / "project.json")
    if kind == "analysis":
        path = directory / "analysis.json"
    elif kind == "audio":
        path = directory / metadata["storedFilename"]
    else:
        candidates = list((directory / "work" / "ensemble" / "sonif").glob("*.markers.mp3"))
        path = candidates[0] if candidates else Path("/missing")
    if not path.is_file():
        abort(404)
    return send_file(path, conditional=True)


@app.get("/api/projects/<project_id>/analysis")
def project_analysis(project_id: str):
    return project_file(project_id, "analysis")


@app.get("/api/projects/<project_id>/audio")
def project_audio(project_id: str):
    return project_file(project_id, "audio")


@app.get("/api/projects/<project_id>/markers")
def project_markers(project_id: str):
    return project_file(project_id, "markers")


@app.get("/")
def index():
    return send_from_directory(APP_DIR, "index.html")


@app.get("/<asset>")
def static_asset(asset: str):
    if asset not in APP_FILES:
        abort(404)
    return send_from_directory(APP_DIR, asset)


if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    # This Mac only by default; HITMAPPER_HOST=0.0.0.0 opens it to the network
    # (HitMapper has no login, so only do that on a network you trust).
    app.run(host=os.environ.get("HITMAPPER_HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8766")), threaded=True)
