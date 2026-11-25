"""Server tests: uploads, the song library, jobs and what the server will serve.

Needs Flask and ffmpeg/ffprobe. The real analyzer is replaced by a small fake
script, so no audio models are needed.
    python -m unittest discover -s tests
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("HITMAPPER_DATA_DIR", tempfile.mkdtemp(prefix="hitmapper-import-"))

import server  # noqa: E402

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))

FAKE_PIPELINE = textwrap.dedent('''
    import argparse, json, os, sys
    parser = argparse.ArgumentParser()
    for name in ("--source", "--work", "--output", "--track-name"):
        parser.add_argument(name)
    args = parser.parse_args()
    print("Finding song structure", flush=True)
    if os.environ.get("FAKE_ANALYZER_FAIL"):
        print("model crashed", flush=True)
        sys.exit(3)
    os.makedirs(args.work, exist_ok=True)
    with open(args.output, "w") as handle:
        json.dump({"version": 2, "track": {"name": args.track_name, "duration": 2.0}}, handle)
    print("Prepared 1 model segments", flush=True)
''')


class FakeExecutor:
    def __init__(self):
        self.submitted = []

    def submit(self, function, *args):
        self.submitted.append(args)


class ServerTestCase(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="hitmapper-test-"))
        self.data = self.folder / "data"
        self.app_dir = self.folder / "app"
        self.app_dir.mkdir()
        (self.app_dir / "analysis_pipeline.py").write_text(FAKE_PIPELINE)
        self.executor = FakeExecutor()
        patches = [
            mock.patch.object(server, "DATA_DIR", self.data),
            mock.patch.object(server, "PROJECTS_DIR", self.data / "projects"),
            mock.patch.object(server, "runtime_initialized", False),
            mock.patch.object(server, "executor", self.executor),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(shutil.rmtree, self.folder, True)
        self.client = server.app.test_client()

    def tone(self, seconds=2.0, name="tone.wav"):
        path = self.folder / name
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                        "sine=frequency=440:duration=%s" % seconds, str(path)], check=True)
        return path

    def upload(self, path, name=None):
        with open(path, "rb") as handle:
            data = {"song": (handle, path.name)}
            if name is not None:
                data["name"] = name
            return self.client.post("/api/tracks", data=data, content_type="multipart/form-data")

    def make_project(self, status, project_id="ab12"):
        directory = self.data / "projects" / project_id
        directory.mkdir(parents=True)
        source = directory / "source.wav"
        source.write_bytes(b"RIFF")
        server.write_json(directory / "project.json", {
            "id": project_id, "name": "Song", "filename": "song.wav", "storedFilename": "source.wav",
            "status": status, "stage": status, "progress": 1, "createdAt": "2026-01-01T00:00:00+00:00",
        })
        return directory


class StaticFileTests(ServerTestCase):
    def test_only_the_page_and_its_two_files_are_served(self):
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        page.close()
        for name in ("app.js", "styles.css"):
            response = self.client.get("/" + name)
            self.assertEqual(response.status_code, 200, name)
            response.close()
        for path in ("/server.py", "/analysis_pipeline.py", "/Dockerfile", "/README.md",
                     "/.runtime-data/state.json", "/archive/model-analysis.json", "/../server.py",
                     "/api/active/audio", "/HitMapper"):
            self.assertEqual(self.client.get(path).status_code, 404, path)

    def test_other_host_names_are_refused(self):
        # A DNS-rebinding page reaches 127.0.0.1 under its own host name.
        self.assertEqual(self.client.get("/api/status", headers={"Host": "evil.example:8766"}).status_code, 403)
        self.assertEqual(self.client.get("/api/status", headers={"Host": "127.0.0.1:8766"}).status_code, 200)
        with mock.patch.object(server, "ALLOWED_HOSTS", server.ALLOWED_HOSTS | {"studio.local"}):
            self.assertEqual(self.client.get("/api/status", headers={"Host": "studio.local:8766"}).status_code, 200)

    def test_posts_from_other_sites_are_refused(self):
        self.make_project("failed")
        response = self.client.post("/api/projects/ab12/retry", headers={"Origin": "https://evil.example"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.executor.submitted, [])
        response = self.client.post("/api/projects/ab12/retry", headers={"Origin": "http://localhost"})
        self.assertEqual(response.status_code, 202, "the app's own page is allowed")

    def test_project_ids_must_be_hex(self):
        for project_id in ("..", "ABC", "not-hex", "ab12%2F..%2F.."):
            self.assertEqual(self.client.get("/api/projects/%s/analysis" % project_id).status_code, 404)


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg and ffprobe")
class UploadTests(ServerTestCase):
    def test_a_song_is_saved_and_queued(self):
        response = self.upload(self.tone(), name="  My Song  ")
        self.assertEqual(response.status_code, 202)
        project = response.get_json()["project"]
        self.assertEqual((project["name"], project["status"]), ("My Song", "queued"))
        directory = self.data / "projects" / project["id"]
        self.assertTrue((directory / "source.wav").is_file())
        self.assertEqual(json.loads((directory / "project.json").read_text())["storedFilename"], "source.wav")
        self.assertEqual(self.executor.submitted, [(project["id"],)])
        status = self.client.get("/api/status").get_json()
        self.assertEqual([p["id"] for p in status["projects"]], [project["id"]])
        self.assertEqual(status["currentJob"]["id"], project["id"])
        self.assertNotIn("active", status)

    def test_no_file_wrong_type_or_not_audio_is_refused_and_nothing_is_kept(self):
        self.assertEqual(self.client.post("/api/tracks", data={}).status_code, 400)
        text = self.folder / "notes.txt"
        text.write_text("hello")
        self.assertIn("Unsupported audio type", self.upload(text).get_json()["error"])
        fake = self.folder / "fake.mp3"
        fake.write_bytes(b"not audio at all")
        response = self.upload(fake)
        self.assertEqual(response.status_code, 400)
        self.assertIn("could not be read as audio", response.get_json()["error"])
        self.assertEqual(list((self.data / "projects").iterdir()), [], "the failed upload's folder is removed")
        self.assertEqual(self.executor.submitted, [])

    def test_non_latin_file_names_are_accepted(self):
        response = self.upload(self.tone(name="Песня.wav"))
        self.assertEqual(response.status_code, 202, response.get_json())
        project = response.get_json()["project"]
        self.assertEqual(project["name"], "Песня")
        self.assertTrue((self.data / "projects" / project["id"] / "source.wav").is_file())

    def test_too_short_is_refused(self):
        response = self.upload(self.tone(seconds=0.5))
        self.assertEqual(response.status_code, 400)
        self.assertIn("between 1 second and 30 minutes", response.get_json()["error"])


class JobTests(ServerTestCase):
    def run_job(self, directory, fail=False):
        env = {"FAKE_ANALYZER_FAIL": "1"} if fail else {}
        with mock.patch.object(server, "APP_DIR", self.app_dir), mock.patch.dict(os.environ, env):
            server.analyze_project(directory.name)
        return server.read_json(directory / "project.json")

    def test_a_finished_analysis_is_ready_and_its_files_are_served(self):
        directory = self.make_project("queued")
        metadata = self.run_job(directory)
        self.assertEqual((metadata["status"], metadata["progress"]), ("ready", 100))
        self.assertIn("Prepared", (directory / "analysis.log").read_text())
        analysis = self.client.get("/api/projects/ab12/analysis")
        self.assertEqual(analysis.get_json()["track"]["name"], "Song")
        analysis.close()
        audio = self.client.get("/api/projects/ab12/audio")
        self.assertEqual(audio.status_code, 200)
        audio.close()
        self.assertEqual(self.client.get("/api/projects/ab12/markers").status_code, 404, "no marker audio yet")
        self.assertFalse((self.data / "state.json").exists())

    def test_a_failed_analysis_reports_the_end_of_its_log_and_can_be_retried(self):
        directory = self.make_project("queued")
        metadata = self.run_job(directory, fail=True)
        self.assertEqual(metadata["status"], "failed")
        self.assertIn("status 3", metadata["error"])
        self.assertIn("model crashed", metadata["error"])
        response = self.client.post("/api/projects/ab12/retry")
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.get_json()["project"]["status"], "queued")
        self.assertEqual(self.executor.submitted, [("ab12",)])

    def test_running_out_of_memory_is_explained(self):
        directory = self.make_project("queued")
        (self.app_dir / "analysis_pipeline.py").write_text("import os, signal; os.kill(os.getpid(), signal.SIGKILL)\n")
        metadata = self.run_job(directory)
        self.assertEqual(metadata["status"], "failed")
        self.assertIn("ran out of memory", metadata["error"])
        self.assertIn("Retry", metadata["error"])

    def test_only_failed_songs_can_be_retried(self):
        self.make_project("ready")
        self.assertEqual(self.client.post("/api/projects/ab12/retry").status_code, 409)

    def test_unfinished_jobs_resume_after_a_restart(self):
        self.make_project("analyzing", "aa01")
        self.make_project("ready", "bb02")
        self.client.get("/api/status")
        self.assertEqual(self.executor.submitted, [("aa01",)])
        self.assertEqual(server.read_json(self.data / "projects" / "aa01" / "project.json")["status"], "queued")


if __name__ == "__main__":
    unittest.main()
