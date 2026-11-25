#!/usr/bin/env python3
"""Run HitMapper's local structural analysis and prepare browser-ready QA data."""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import argparse
from datetime import datetime, timezone
from pathlib import Path


# Per-song paths, set by configure_paths() from the command line.
WORK = Path()
TRACK_STEM = ""
SOURCE_MP3 = Path()
SOURCE_WAV = Path()
VENV = Path()
ANALYZER = Path()
RESULT = Path()
FOLD_RESULT = Path()
SONIFIED_WAV = Path()
MARKERS_MP3 = Path()
OUTPUT_JSON = Path()
CHORD_CACHE = Path()
FEATURE_CACHE = Path()
TRACK_NAME = ""

# Bump when a change to the chord or audio-event analysis should replace
# results cached in each song's work folder.
CHORD_CACHE_VERSION = 4
FEATURE_CACHE_VERSION = 4

# The song's musical grid, set by configure_timing() from the model's beats.
BAR_ONE = 0.0
BAR_DURATION = 2.5
TOTAL_BARS = 1
TRACK_DURATION = 0.0


def configure_paths(source: Path, work: Path, output: Path, track_name: str | None) -> None:
    """Point one analyzer process at an isolated uploaded-song workspace."""
    global WORK, TRACK_STEM, SOURCE_MP3, SOURCE_WAV, VENV, ANALYZER, RESULT
    global FOLD_RESULT, SONIFIED_WAV, MARKERS_MP3, OUTPUT_JSON, CHORD_CACHE
    global FEATURE_CACHE, TRACK_NAME
    SOURCE_MP3 = source.resolve()
    TRACK_STEM = SOURCE_MP3.stem
    WORK = work.resolve()
    SOURCE_WAV = WORK / f"{TRACK_STEM}.wav"
    VENV = Path(os.environ.get("VIRTUAL_ENV", WORK / "venv"))
    configured_analyzer = os.environ.get("HITMAPPER_ANALYZER")
    discovered = shutil.which("all-in-one-infer")
    if configured_analyzer:
        ANALYZER = Path(configured_analyzer)
    elif discovered:
        ANALYZER = Path(discovered)
    else:
        ANALYZER = VENV / "bin" / "all-in-one-infer"
    RESULT = WORK / "ensemble" / "struct" / f"{TRACK_STEM}.json"
    FOLD_RESULT = WORK / "struct" / f"{TRACK_STEM}.json"
    SONIFIED_WAV = WORK / "ensemble" / "sonif" / f"{TRACK_STEM}.sonif.wav"
    MARKERS_MP3 = WORK / "ensemble" / "sonif" / f"{TRACK_STEM}.markers.mp3"
    OUTPUT_JSON = output.resolve()
    CHORD_CACHE = WORK / "chords" / f"{TRACK_STEM}.json"
    FEATURE_CACHE = WORK / "features" / f"{TRACK_STEM}.json"
    TRACK_NAME = track_name or SOURCE_MP3.stem.replace("_", " ").replace("-", " ")


def configure_timing(result: dict) -> None:
    """Derive the musical grid (bar 1, bar length, bar count) from the model's downbeats."""
    global BAR_ONE, BAR_DURATION, TOTAL_BARS, TRACK_DURATION
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(SOURCE_MP3)],
        check=True,
        capture_output=True,
        text=True,
    )
    TRACK_DURATION = float(probe.stdout.strip())
    downbeats = sorted(float(value) for value in result.get("downbeats", []))
    if len(downbeats) >= 2:
        intervals = sorted(
            right - left for left, right in zip(downbeats, downbeats[1:])
            if 0.8 <= right - left <= 8.0
        )
        BAR_DURATION = intervals[len(intervals) // 2] if intervals else 240.0 / max(1.0, float(result.get("bpm", 96)))
        # Structure models may omit quiet opening downbeats. Project the first
        # confident downbeat backwards to the opening bar phase so numbering
        # still begins at the track entrance rather than several bars late.
        missing_opening_bars = math.ceil(downbeats[0] / BAR_DURATION)
        BAR_ONE = downbeats[0] - missing_opening_bars * BAR_DURATION
        if BAR_ONE < -BAR_DURATION * 0.6:
            BAR_ONE += BAR_DURATION
        TOTAL_BARS = max(1, round((TRACK_DURATION - BAR_ONE) / BAR_DURATION))
    else:
        BAR_DURATION = 240.0 / max(1.0, float(result.get("bpm", 96)))
        BAR_ONE = 0.0
        TOTAL_BARS = max(1, math.ceil(TRACK_DURATION / BAR_DURATION))

def run(command: list[str]) -> None:
    print("+", " ".join(command))
    subprocess.run(command, cwd=WORK, check=True)


def bar_start(bar: int) -> float:
    return max(0.0, BAR_ONE + (bar - 1) * BAR_DURATION)


def nearest_bar(time: float) -> int:
    return max(1, min(TOTAL_BARS, round((time - BAR_ONE) / BAR_DURATION) + 1))


def corrected_bar_starts(downbeats: list[float]) -> list[float]:
    """Bar start times (index = bar number) on the detected downbeats.

    Mirrors buildCorrectedTimingGrid() in app.js, so the browser and the
    analysis use the same bars: a downbeat within min(1.25 s, half a bar) of a
    nominal bar start replaces it, but only when a neighbouring downbeat lies
    about one bar away (within 10%), so a free or slower passage stays on the
    nominal grid; bars between matched ones are interpolated, bars after the
    last are projected at the recent median bar length, and starts are kept
    increasing and within the track.
    """
    tolerance = min(1.25, BAR_DURATION * 0.5)
    starts = [bar_start(bar) for bar in range(TOTAL_BARS + 2)]
    times = sorted(float(time) for time in downbeats)

    def steady(interval: float | None) -> bool:
        return interval is not None and abs(interval - BAR_DURATION) <= BAR_DURATION * 0.1

    mapped: dict[int, float] = {}
    for index, time in enumerate(times):
        before = time - times[index - 1] if index > 0 else None
        after = times[index + 1] - time if index + 1 < len(times) else None
        if not steady(before) and not steady(after):
            continue
        bar = nearest_bar(time)
        if abs(time - bar_start(bar)) <= tolerance:
            mapped[bar] = time
    mapped_bars = sorted(mapped)
    for index, bar in enumerate(mapped_bars):
        starts[bar] = mapped[bar]
        if index + 1 < len(mapped_bars):
            following = mapped_bars[index + 1]
            step = (mapped[following] - mapped[bar]) / (following - bar)
            for between in range(bar + 1, following):
                starts[between] = mapped[bar] + (between - bar) * step
    if mapped_bars:
        intervals = sorted(
            mapped[bar] - mapped[bar - 1]
            for bar in mapped_bars[-17:]
            if bar - 1 in mapped
        )
        midpoint = len(intervals) // 2
        projected = (
            intervals[midpoint]
            if len(intervals) % 2
            else (intervals[midpoint - 1] + intervals[midpoint]) / 2
        ) if intervals else BAR_DURATION
        last_bar = mapped_bars[-1]
        for bar in range(last_bar + 1, TOTAL_BARS + 1):
            starts[bar] = starts[last_bar] + (bar - last_bar) * projected
    starts[TOTAL_BARS + 1] = TRACK_DURATION
    gap = min(0.001, TRACK_DURATION / (4 * (TOTAL_BARS + 1))) if TRACK_DURATION > 0 else 0.0
    starts[1] = max(0.0, starts[1])
    for bar in range(2, TOTAL_BARS + 1):
        starts[bar] = max(starts[bar], starts[bar - 1] + gap)
    for bar in range(TOTAL_BARS, 0, -1):
        starts[bar] = min(starts[bar], starts[bar + 1] - gap)
    return starts


def ensure_wav() -> None:
    if SOURCE_WAV.exists() and SOURCE_WAV.stat().st_mtime >= SOURCE_MP3.stat().st_mtime:
        return
    WORK.mkdir(parents=True, exist_ok=True)
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-stats", "-y",
        "-i", str(SOURCE_MP3), "-c:a", "pcm_s16le", "-ar", "44100", str(SOURCE_WAV),
    ])


def ensure_analysis() -> None:
    if RESULT.exists() and RESULT.stat().st_mtime >= SOURCE_WAV.stat().st_mtime:
        return
    if not ANALYZER.exists():
        raise SystemExit(
            "The all-in-one-infer analyzer was not found. Run HitMapper in Docker, "
            "or install requirements.txt into the active Python environment."
        )

    demix_dir = WORK / "demix"
    spec_dir = WORK / "spec"
    stem_dir = demix_dir / "htdemucs" / TRACK_STEM
    stems_ready = all((stem_dir / f"{name}.wav").exists() for name in ("bass", "drums", "other", "vocals"))

    command = [
        str(ANALYZER), str(SOURCE_WAV),
        "-o", str(RESULT.parent),
        "-v", "--viz-dir", str(WORK / "ensemble" / "viz"),
        "-s", "--sonif-dir", str(SONIFIED_WAV.parent),
        "-m", "harmonix-all", "-d", os.environ.get("HITMAPPER_DEVICE", "cpu"), "-k",
        "--demix-dir", str(demix_dir), "--spec-dir", str(spec_dir),
        "--no-multiprocess", "--overwrite",
    ]
    if stems_ready:
        command.append("--skip-separation")
    run(command)


def ensure_marker_audio() -> None:
    if not SONIFIED_WAV.exists():
        # Marker audio is optional: the map still works without it.
        print(f"No marker audio: the analyzer wrote no {SONIFIED_WAV.name}")
        return
    if MARKERS_MP3.exists() and MARKERS_MP3.stat().st_mtime >= SONIFIED_WAV.stat().st_mtime:
        return
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-stats", "-y",
        "-i", str(SONIFIED_WAV), "-codec:a", "libmp3lame", "-q:a", "2", str(MARKERS_MP3),
    ])


def import_numpy():
    """numpy, with the old np.float/np.int aliases that madmom still uses."""
    import numpy as np

    for name, value in (("float", float), ("int", int), ("complex", complex), ("bool", bool), ("object", object)):
        if name not in np.__dict__:
            setattr(np, name, value)
    return np


def analyze_chords(result: dict) -> dict:
    stem_dir = WORK / "demix" / "htdemucs" / TRACK_STEM
    other_path = stem_dir / "other.wav"
    bass_path = stem_dir / "bass.wav"
    newest_input = max(other_path.stat().st_mtime, bass_path.stat().st_mtime, RESULT.stat().st_mtime)
    if CHORD_CACHE.exists() and CHORD_CACHE.stat().st_mtime >= newest_input:
        cached = json.loads(CHORD_CACHE.read_text())
        if cached.get("version") == CHORD_CACHE_VERSION and cached.get("barCount", TOTAL_BARS) == TOTAL_BARS:
            return cached

    np = import_numpy()

    import librosa
    from madmom.audio.chroma import DeepChromaProcessor
    from madmom.features.chords import DeepChromaChordRecognitionProcessor
    from madmom.processors import SequentialProcessor

    chord_model = SequentialProcessor([DeepChromaProcessor(), DeepChromaChordRecognitionProcessor()])
    neural_events = chord_model(str(other_path))
    starts = corrected_bar_starts(result["downbeats"])
    sample_rate = 22050
    hop_length = 2048
    chroma_features = {}
    tuning = 0.0
    # The mix comes first so its tuning estimate applies to the stems as well.
    for role, path in (("mix", SOURCE_WAV), ("other", other_path), ("bass", bass_path)):
        audio, _ = librosa.load(path, sr=sample_rate, mono=True)
        harmonic = librosa.effects.harmonic(audio, margin=2.0)
        if role == "mix":
            tuning = float(librosa.estimate_tuning(
                y=harmonic,
                sr=sample_rate,
                bins_per_octave=36,
            ))
        chroma_features[role] = librosa.feature.chroma_cqt(
            y=harmonic,
            sr=sample_rate,
            hop_length=hop_length,
            bins_per_octave=36,
            tuning=tuning,
        )

    neural_by_bar: list[str] = []
    for bar in range(1, TOTAL_BARS + 1):
        bar_start = starts[bar]
        bar_end = starts[bar + 1]
        label_durations: dict[str, float] = {}
        for event in neural_events:
            overlap = max(0.0, min(bar_end, float(event["end"])) - max(bar_start, float(event["start"])))
            if overlap <= 0:
                continue
            label = str(event["label"])
            label_durations[label] = label_durations.get(label, 0.0) + overlap
        neural_by_bar.append(max(label_durations, key=label_durations.get) if label_durations else "N")

    bar_features = []
    for bar in range(1, TOTAL_BARS + 1):
        vectors = {}
        for role, chroma in chroma_features.items():
            start_frame = max(0, int(math.floor(starts[bar] * sample_rate / hop_length)))
            end_frame = min(chroma.shape[1], max(start_frame + 1, int(math.ceil(starts[bar + 1] * sample_rate / hop_length))))
            vector = np.median(chroma[:, start_frame:end_frame], axis=1)
            vector = vector / (vector.sum() + 1e-9)
            vectors[role] = vector
        harmony = .64 * vectors["other"] + .36 * vectors["mix"]
        harmony = harmony / (harmony.sum() + 1e-9)
        bar_features.append({"harmony": harmony, "bass": vectors["bass"]})

    note_names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

    # Estimate a global tonal centre only as a weak contextual prior. Rock harmony
    # often borrows chords, so acoustics always outweigh the key estimate.
    major_profile = np.asarray([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor_profile = np.asarray([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    global_chroma = np.median(np.asarray([item["harmony"] for item in bar_features]), axis=0)
    key_candidates = []
    for tonic in range(12):
        key_candidates.append((float(np.dot(global_chroma, np.roll(major_profile, tonic))), tonic, "major"))
        key_candidates.append((float(np.dot(global_chroma, np.roll(minor_profile, tonic))), tonic, "minor"))
    _, key_root, key_mode = max(key_candidates)
    key_name = f"{note_names[key_root]} {key_mode}"

    scale_degrees = {
        "major": ([0, 2, 4, 5, 7, 9, 11], ["maj", "min", "min", "maj", "maj", "min", "dim"]),
        "minor": ([0, 2, 3, 5, 7, 8, 10], ["min", "dim", "maj", "min", "min", "maj", "maj"]),
    }
    degrees, degree_qualities = scale_degrees[key_mode]
    diatonic = {(key_root + degree) % 12: quality for degree, quality in zip(degrees, degree_qualities)}

    quality_specs = {
        "maj": ((0, 4, 7), (1.0, .86, .68), .00),
        "min": ((0, 3, 7), (1.0, .86, .68), .00),
        "5": ((0, 7), (1.0, .76), .015),
        "sus2": ((0, 2, 7), (1.0, .72, .66), .025),
        "sus4": ((0, 5, 7), (1.0, .76, .66), .025),
        "7": ((0, 4, 7, 10), (1.0, .82, .62, .52), .045),
        "maj7": ((0, 4, 7, 11), (1.0, .82, .62, .50), .05),
        "min7": ((0, 3, 7, 10), (1.0, .82, .62, .52), .045),
        "dim": ((0, 3, 6), (1.0, .80, .66), .04),
    }

    def parse_neural(label: str) -> tuple[int | None, str | None]:
        if label == "N" or ":" not in label:
            return None, None
        root_name, quality = label.split(":", 1)
        return (note_names.index(root_name), quality) if root_name in note_names else (None, None)

    def chord_name(root: int, quality: str, bass: int | None = None) -> str:
        suffixes = {
            "maj": "", "min": "m", "5": "5", "sus2": "sus2", "sus4": "sus4",
            "7": "7", "maj7": "maj7", "min7": "m7", "dim": "dim",
        }
        label = f"{note_names[root]}{suffixes[quality]}"
        if bass is not None and bass != root:
            label += f"/{note_names[bass]}"
        return label

    def candidate_scores(harmony: np.ndarray, bass: np.ndarray, neural_label: str) -> list[dict]:
        neural_root, neural_quality = parse_neural(neural_label)
        harmony_norm = harmony / (np.linalg.norm(harmony) + 1e-9)
        candidates = []
        for root in range(12):
            for quality, (intervals, weights, complexity_penalty) in quality_specs.items():
                tones = tuple((root + interval) % 12 for interval in intervals)
                template = np.zeros(12)
                for tone, weight in zip(tones, weights):
                    template[tone] = weight
                template /= np.linalg.norm(template) + 1e-9
                fit = float(np.dot(harmony_norm, template))
                outside = float(np.mean([harmony[index] for index in range(12) if index not in tones]))
                score = fit - .34 * outside - complexity_penalty
                score += .12 * float(harmony[root]) + .11 * float(bass[root])
                if neural_root == root:
                    score += .09
                if neural_root == root and neural_quality == quality:
                    score += .09
                if diatonic.get(root) == quality:
                    score += .025
                candidates.append({
                    "root": root,
                    "quality": quality,
                    "tones": tones,
                    "score": score,
                })
        return sorted(candidates, key=lambda item: item["score"], reverse=True)

    chord_bars = []
    previous_chroma = None
    for index, features in enumerate(bar_features):
        neural_label = neural_by_bar[index]
        harmony = features["harmony"]
        bass = features["bass"]
        ranked = candidate_scores(harmony, bass, neural_label)
        chosen = ranked[0]

        # A session player should not invent major/minor quality when the defining
        # third is absent. Prefer honest power-chord notation in that case.
        if chosen["quality"] in {"maj", "min"}:
            third_interval = 4 if chosen["quality"] == "maj" else 3
            opposite_interval = 3 if chosen["quality"] == "maj" else 4
            third_strength = float(harmony[(chosen["root"] + third_interval) % 12])
            opposite_strength = float(harmony[(chosen["root"] + opposite_interval) % 12])
            power = next(item for item in ranked if item["root"] == chosen["root"] and item["quality"] == "5")
            if third_strength < .045 or third_strength < opposite_strength * 1.08:
                if power["score"] >= chosen["score"] - .11:
                    chosen = power

        alternatives = [item for item in ranked if item["root"] != chosen["root"] or item["quality"] != chosen["quality"]]
        runner_up = alternatives[0]
        neural_root, neural_quality = parse_neural(neural_label)
        bass_order = np.argsort(bass)[::-1]
        bass_note = int(bass_order[0])
        bass_margin = float(bass[bass_note] - bass[int(bass_order[1])])
        slash_bass = None
        if (
            chosen["quality"] != "5"
            and bass_note != chosen["root"]
            and bass_note in chosen["tones"]
            and bass_margin >= .035
            and float(bass[bass_note]) > float(bass[chosen["root"]]) * 1.28
        ):
            slash_bass = bass_note

        label = chord_name(chosen["root"], chosen["quality"], slash_bass)
        alternate = chord_name(runner_up["root"], runner_up["quality"])
        margin = max(0.0, float(chosen["score"] - runner_up["score"]))
        neural_agreement = neural_root == chosen["root"] and (
            chosen["quality"] == "5" or neural_quality == chosen["quality"]
        )
        root_bass_agreement = bass_note == chosen["root"]
        confidence = float(np.clip(
            .30 + 2.35 * margin + (.15 if neural_agreement else 0.0) + (.08 if root_bass_agreement else 0.0),
            0.0,
            1.0,
        ))
        evidence = []
        if neural_agreement:
            evidence.append("neural agreement")
        if root_bass_agreement:
            evidence.append("bass supports root")
        if slash_bass is not None:
            evidence.append(f"stable {note_names[slash_bass]} bass")
        if chosen["quality"] == "5":
            evidence.append("third unclear")
        else:
            evidence.append(f"{chosen['quality']} chord tones")

        chroma = harmony
        if previous_chroma is None:
            change_strength = 0.0
        else:
            cosine = float(np.dot(previous_chroma, chroma) / ((np.linalg.norm(previous_chroma) * np.linalg.norm(chroma)) + 1e-9))
            change_strength = max(0.0, min(1.0, 1.0 - cosine))
        previous_chroma = chroma
        chord_bars.append({
            "bar": index + 1,
            "name": "N" if neural_label == "N" else label,
            "root": "N" if neural_label == "N" else note_names[chosen["root"]],
            "quality": "N" if neural_label == "N" else chosen["quality"],
            "bass": note_names[slash_bass] if slash_bass is not None else note_names[bass_note],
            "confidence": round(.72 if neural_label == "N" else confidence, 3),
            "changeStrength": round(change_strength, 3),
            "neuralLabel": neural_label,
            "alternate": alternate,
            "evidence": ["neural no-chord"] if neural_label == "N" else evidence,
        })

    # Resolve chord quality over contiguous root spans. This mirrors the way a
    # player hears one harmonic event as a whole instead of changing notation
    # whenever a defining tone briefly drops out inside the voicing.
    root_spans = []
    for index, chord in enumerate(chord_bars):
        if root_spans and root_spans[-1]["root"] == chord["root"]:
            root_spans[-1]["end"] = index
        else:
            root_spans.append({"root": chord["root"], "start": index, "end": index})

    for span in root_spans:
        if span["root"] == "N":
            continue
        first = span["start"]
        last = span["end"] + 1
        root = note_names.index(span["root"])
        harmony = np.median(np.asarray([bar_features[index]["harmony"] for index in range(first, last)]), axis=0)
        harmony /= harmony.sum() + 1e-9
        bass = np.median(np.asarray([bar_features[index]["bass"] for index in range(first, last)]), axis=0)
        bass /= bass.sum() + 1e-9
        labels = neural_by_bar[first:last]
        neural_label = max(set(labels), key=labels.count)
        ranked = [item for item in candidate_scores(harmony, bass, neural_label) if item["root"] == root]
        chosen = ranked[0]
        if chosen["quality"] in {"maj", "min"}:
            third_interval = 4 if chosen["quality"] == "maj" else 3
            opposite_interval = 3 if chosen["quality"] == "maj" else 4
            third_strength = float(harmony[(root + third_interval) % 12])
            opposite_strength = float(harmony[(root + opposite_interval) % 12])
            power = next(item for item in ranked if item["quality"] == "5")
            if third_strength < .045 or third_strength < opposite_strength * 1.08:
                if power["score"] >= chosen["score"] - .11:
                    chosen = power
        runner_up = next(item for item in ranked if item["quality"] != chosen["quality"])
        bass_order = np.argsort(bass)[::-1]
        bass_note = int(bass_order[0])
        bass_margin = float(bass[bass_note] - bass[int(bass_order[1])])
        slash_bass = None
        if (
            chosen["quality"] != "5"
            and bass_note != root
            and bass_note in chosen["tones"]
            and bass_margin >= .045
            and float(bass[bass_note]) > float(bass[root]) * 1.35
        ):
            slash_bass = bass_note
        neural_root, neural_quality = parse_neural(neural_label)
        neural_agreement = neural_root == root and (chosen["quality"] == "5" or neural_quality == chosen["quality"])
        root_bass_agreement = bass_note == root
        confidence = float(np.clip(
            .34 + 2.5 * max(0.0, chosen["score"] - runner_up["score"])
            + (.16 if neural_agreement else 0.0)
            + (.08 if root_bass_agreement else 0.0),
            0.0,
            1.0,
        ))
        evidence = ["whole-span voicing"]
        if neural_agreement:
            evidence.append("neural agreement")
        if root_bass_agreement:
            evidence.append("bass supports root")
        if slash_bass is not None:
            evidence.append(f"stable {note_names[slash_bass]} bass")
        if chosen["quality"] == "5":
            evidence.append("third unclear")
        else:
            evidence.append(f"{chosen['quality']} chord tones")
        label = chord_name(root, chosen["quality"], slash_bass)
        alternate = chord_name(root, runner_up["quality"])
        for index in range(first, last):
            chord_bars[index].update({
                "name": label,
                "quality": chosen["quality"],
                "bass": note_names[slash_bass] if slash_bass is not None else note_names[bass_note],
                "confidence": round(confidence, 3),
                "alternate": alternate,
                "evidence": evidence,
            })

    chord_runs = []
    for chord in chord_bars:
        if chord_runs and chord_runs[-1]["name"] == chord["name"]:
            chord_runs[-1]["endBar"] = chord["bar"]
            chord_runs[-1]["confidence"] = round((chord_runs[-1]["confidence"] + chord["confidence"]) / 2, 3)
            chord_runs[-1]["peakChange"] = max(chord_runs[-1]["peakChange"], chord["changeStrength"])
        else:
            chord_runs.append({
                "startBar": chord["bar"],
                "endBar": chord["bar"],
                "name": chord["name"],
                "confidence": chord["confidence"],
                "peakChange": chord["changeStrength"],
                "alternate": chord["alternate"],
                "evidence": chord["evidence"],
            })

    payload = {
        "version": CHORD_CACHE_VERSION,
        "barCount": TOTAL_BARS,
        "method": "session-chart ensemble: madmom deep chroma + tuned full/stem chroma + bass/inversion + tonal context",
        "chartStyle": "session-musician shorthand",
        "keyEstimate": key_name,
        "tuningCents": round(tuning * 100, 1),
        "vocabulary": list(quality_specs),
        "bars": chord_bars,
        "runs": chord_runs,
    }
    CHORD_CACHE.parent.mkdir(parents=True, exist_ok=True)
    CHORD_CACHE.write_text(json.dumps(payload, indent=2) + "\n")
    return payload


def analyze_audio_events(result: dict, chord_analysis: dict) -> dict:
    """Derive bar energy, transition candidates, and repeated patterns from audio features."""
    newest_input = max(SOURCE_WAV.stat().st_mtime, RESULT.stat().st_mtime, CHORD_CACHE.stat().st_mtime)
    if FEATURE_CACHE.exists() and FEATURE_CACHE.stat().st_mtime >= newest_input:
        cached = json.loads(FEATURE_CACHE.read_text())
        if cached.get("version") == FEATURE_CACHE_VERSION and cached.get("barCount", TOTAL_BARS) == TOTAL_BARS:
            return cached

    np = import_numpy()

    import librosa

    sample_rate = 11025
    hop_length = 1024
    starts = corrected_bar_starts(result["downbeats"])
    other_path = WORK / "demix" / "htdemucs" / TRACK_STEM / "other.wav"
    feature_source = other_path if other_path.exists() else SOURCE_WAV

    feature_audio, _ = librosa.load(feature_source, sr=sample_rate, mono=True)
    harmonic = librosa.effects.harmonic(feature_audio, margin=2.0)
    chroma = librosa.feature.chroma_cqt(
        y=harmonic,
        sr=sample_rate,
        hop_length=hop_length,
        bins_per_octave=36,
    )
    mfcc = librosa.feature.mfcc(y=feature_audio, sr=sample_rate, n_mfcc=8, hop_length=hop_length)
    onset = librosa.onset.onset_strength(y=feature_audio, sr=sample_rate, hop_length=hop_length)
    del feature_audio, harmonic

    mix_audio, _ = librosa.load(SOURCE_WAV, sr=sample_rate, mono=True)
    rms = librosa.feature.rms(y=mix_audio, hop_length=hop_length)[0]
    del mix_audio

    def frames_for_bar(bar: int, frame_count: int) -> tuple[int, int]:
        first = max(0, int(math.floor(starts[bar] * sample_rate / hop_length)))
        last = min(frame_count, max(first + 1, int(math.ceil(starts[bar + 1] * sample_rate / hop_length))))
        return first, last

    bar_chroma = []
    bar_mfcc = []
    bar_onset = []
    bar_rms = []
    for bar in range(1, TOTAL_BARS + 1):
        first, last = frames_for_bar(bar, chroma.shape[1])
        chroma_vector = np.median(chroma[:, first:last], axis=1)
        chroma_vector = chroma_vector / (np.linalg.norm(chroma_vector) + 1e-9)
        bar_chroma.append(chroma_vector)

        first, last = frames_for_bar(bar, mfcc.shape[1])
        bar_mfcc.append(np.median(mfcc[:, first:last], axis=1))

        first, last = frames_for_bar(bar, len(onset))
        bar_onset.append(float(np.mean(onset[first:last])))

        first, last = frames_for_bar(bar, len(rms))
        bar_rms.append(float(np.mean(rms[first:last])))

    bar_chroma_array = np.asarray(bar_chroma)
    bar_mfcc_array = np.asarray(bar_mfcc)
    mfcc_scale = np.std(bar_mfcc_array, axis=0) + 1e-9
    bar_mfcc_array = (bar_mfcc_array - np.mean(bar_mfcc_array, axis=0)) / mfcc_scale
    bar_onset_array = np.asarray(bar_onset)
    bar_rms_array = np.asarray(bar_rms)

    def robust_unit(values: np.ndarray) -> np.ndarray:
        low, high = np.percentile(values, [5, 95])
        return np.clip((values - low) / max(1e-9, high - low), 0.0, 1.0)

    normalized_energy = robust_unit(bar_rms_array)
    normalized_onset = robust_unit(bar_onset_array)

    chord_bars = chord_analysis.get("bars", [])
    chord_change = np.asarray([
        float(chord_bars[index].get("changeStrength", 0.0)) if index < len(chord_bars) else 0.0
        for index in range(TOTAL_BARS)
    ])
    energy_change = np.abs(np.diff(normalized_energy, prepend=normalized_energy[0]))
    onset_change = np.abs(np.diff(normalized_onset, prepend=normalized_onset[0]))
    timbre_change = np.zeros(TOTAL_BARS)
    for index in range(1, TOTAL_BARS):
        left = bar_mfcc_array[index - 1]
        right = bar_mfcc_array[index]
        cosine = float(np.dot(left, right) / ((np.linalg.norm(left) * np.linalg.norm(right)) + 1e-9))
        timbre_change[index] = np.clip((1.0 - cosine) / 2.0, 0.0, 1.0)

    boundary_strength = np.zeros(TOTAL_BARS)
    for previous, upcoming in zip(result.get("segments", []), result.get("segments", [])[1:]):
        bar = nearest_bar(float(upcoming["start"]))
        if 1 < bar <= TOTAL_BARS:
            boundary_strength[bar - 1] = 1.0 if previous.get("label") != upcoming.get("label") else 0.62

    novelty = (
        0.34 * chord_change
        + 0.20 * energy_change
        + 0.14 * onset_change
        + 0.14 * timbre_change
        + 0.18 * boundary_strength
    )
    novelty_threshold = max(0.34, float(np.percentile(novelty[1:], 78)))
    ranked_turns = []
    for index in range(1, TOTAL_BARS):
        left = max(1, index - 2)
        right = min(TOTAL_BARS, index + 3)
        if novelty[index] < novelty_threshold or novelty[index] < np.max(novelty[left:right]):
            continue
        evidence_scores = {
            "harmonic change": chord_change[index],
            "energy change": energy_change[index],
            "attack-density change": onset_change[index],
            "timbre change": timbre_change[index],
            "model boundary": boundary_strength[index],
        }
        evidence = [
            name for name, score in sorted(evidence_scores.items(), key=lambda item: item[1], reverse=True)
            if score >= 0.28
        ][:3]
        ranked_turns.append({
            "time": round(starts[index + 1], 3),
            "bar": index + 1,
            "beat": 1,
            "confidence": round(float(np.clip(novelty[index], 0.0, 1.0)), 3),
            "evidence": evidence,
        })
    ranked_turns.sort(key=lambda item: item["confidence"], reverse=True)
    selected_turns = []
    for candidate in ranked_turns:
        if any(abs(candidate["bar"] - existing["bar"]) < 4 for existing in selected_turns):
            continue
        selected_turns.append(candidate)
        if len(selected_turns) >= 12:
            break
    selected_turns.sort(key=lambda item: item["bar"])

    chord_names = [str(item.get("name", "N")) for item in chord_bars][:TOTAL_BARS]
    chord_names += ["N"] * (TOTAL_BARS - len(chord_names))

    similarity_by_length = {
        length: motif_similarity_matrix(bar_chroma_array, bar_mfcc_array, chord_names, normalized_energy, length)
        for length in (4, 3, 2)
        if TOTAL_BARS >= length
    }

    def motif_similarity(first: int, second: int, length: int) -> float:
        return float(similarity_by_length[length][first, second])

    motif_pairs = []
    for length, similarity in similarity_by_length.items():
        threshold = {4: 0.865, 3: 0.88, 2: 0.90}[length]
        windows = similarity.shape[0]
        firsts, seconds = np.nonzero(np.triu(similarity >= threshold, k=length))
        motif_pairs.extend(
            (float(similarity[first, second]), length, int(first), int(second))
            for first, second in zip(firsts, seconds)
            if second < windows
        )
    motif_pairs.sort(key=lambda item: (item[0] + 0.012 * item[1]), reverse=True)

    used_ranges: list[tuple[int, int]] = []
    motif_groups = []

    def overlaps_used(start: int, length: int) -> bool:
        end = start + length - 1
        return any(start <= used_end and end >= used_start for used_start, used_end in used_ranges)

    for score, length, first, second in motif_pairs:
        if overlaps_used(first, length) or overlaps_used(second, length):
            continue
        occurrence_starts = [first, second]
        occurrence_scores = [score]
        extension_threshold = {4: 0.875, 3: 0.89, 2: 0.91}[length]
        for candidate in range(0, TOTAL_BARS - length + 1):
            if any(abs(candidate - existing) < length for existing in occurrence_starts):
                continue
            if overlaps_used(candidate, length):
                continue
            candidate_score = motif_similarity(first, candidate, length)
            if candidate_score >= extension_threshold:
                occurrence_starts.append(candidate)
                occurrence_scores.append(candidate_score)
        occurrence_starts.sort()
        if len(occurrence_starts) < 2:
            continue
        motif_index = len(motif_groups) + 1
        ranges = [[start + 1, start + length] for start in occurrence_starts]
        confidence = float(np.median(occurrence_scores))
        motif_groups.append({
            "id": f"R{motif_index}",
            "name": f"Detected {length}-bar repeat",
            "lengthBars": length,
            "confidence": round(confidence, 3),
            "ranges": ranges,
        })
        used_ranges.extend((start, start + length - 1) for start in occurrence_starts)
        if len(motif_groups) >= 4:
            break

    payload = {
        "version": FEATURE_CACHE_VERSION,
        "barCount": TOTAL_BARS,
        "barEnergy": [round(float(value), 3) for value in normalized_energy],
        "turnAnalysis": {
            "method": "beat-synchronous harmonic, energy, onset, timbre, and model-boundary novelty",
            "threshold": round(novelty_threshold, 3),
            "candidates": selected_turns,
        },
        "motifAnalysis": {
            "method": "beat-synchronous other-instruments-stem chroma/timbre self-similarity with chord and energy agreement",
            "groups": motif_groups,
        },
    }
    FEATURE_CACHE.parent.mkdir(parents=True, exist_ok=True)
    FEATURE_CACHE.write_text(json.dumps(payload, indent=2) + "\n")
    return payload


# Standard section types: display name, short ribbon/wheel label, colour key.
SECTION_TYPES = {
    "intro": ("Intro", "Intro"),
    "verse": ("Verse", "Verse"),
    "prechorus": ("Pre-chorus", "Pre-chorus"),
    "chorus": ("Chorus", "Chorus"),
    "bridge": ("Bridge", "Bridge"),
    "solo": ("Solo", "Solo"),
    "instrumental": ("Instrumental", "Inst"),
    "build": ("Build", "Build"),
    "breakdown": ("Breakdown", "Breakdown"),
    "interlude": ("Interlude", "Interlude"),
    "outro": ("Outro", "Outro"),
}
# Model labels (harmonix-all) that name a section type directly.
LABEL_TYPES = {"verse": "verse", "chorus": "chorus", "bridge": "bridge", "solo": "solo", "outro": "outro"}
MIN_SECTION_BARS = 2


def section_units(segments: list[dict]) -> list[dict]:
    """Model segments as contiguous bar ranges covering bar 1 to the last bar.

    Segments shorter than MIN_SECTION_BARS are folded into a neighbour.
    """
    units = [
        {"label": segment["label"], "startBar": segment["startBar"], "endBar": segment["endBar"]}
        for segment in segments
        if segment["label"] not in {"start", "end"} and segment["endBar"] >= segment["startBar"]
    ]
    if not units:
        return []
    for previous, upcoming in zip(units, units[1:]):
        upcoming["startBar"] = max(upcoming["startBar"], previous["startBar"] + 1)
        previous["endBar"] = upcoming["startBar"] - 1
    units[0]["startBar"] = 1
    units[-1]["endBar"] = TOTAL_BARS
    units = [unit for unit in units if unit["endBar"] >= unit["startBar"]]
    index = 0
    while len(units) > 1 and index < len(units):
        unit = units[index]
        if unit["endBar"] - unit["startBar"] + 1 >= MIN_SECTION_BARS:
            index += 1
            continue
        if index + 1 < len(units):
            units[index + 1]["startBar"] = unit["startBar"]
        else:
            units[index - 1]["endBar"] = unit["endBar"]
        units.pop(index)
    return units


def classify_sections(units: list[dict], bar_energy: list[float]) -> list[str]:
    """Give each unit a standard section type from its model label, energy and context.

    The model's own verse/chorus/bridge/solo/outro labels are kept. Passages the
    model calls intro, inst or break are named from what the audio does there:
    quiet passages are breakdowns, passages whose energy climbs into a louder
    section are builds, a short build straight into a chorus is a pre-chorus.
    """
    energy = [float(value) for value in bar_energy] or [0.0]
    ordered = sorted(energy)
    median = ordered[len(ordered) // 2]
    # Quiet: among the quietest bars, and clearly below the song's usual level
    # (a percentile alone drifts up when a song has long quiet passages).
    quiet = min(ordered[int(len(ordered) * 0.30)], median - 0.2)

    def stats(unit: dict) -> tuple[float, float, float]:
        values = energy[unit["startBar"] - 1:unit["endBar"]] or [0.0]
        half = max(1, len(values) // 2)
        first = sum(values[:half]) / half
        second = sum(values[half:]) / max(1, len(values) - half) if len(values) > half else first
        return sum(values) / len(values), first, second

    means = [stats(unit)[0] for unit in units]
    types: list[str | None] = [None] * len(units)
    for index, unit in enumerate(units):
        label = unit["label"]
        mean, first, second = stats(unit)
        upcoming = means[index + 1] if index + 1 < len(units) else None
        is_first, is_last = index == 0, index == len(units) - 1
        if label in LABEL_TYPES:
            types[index] = LABEL_TYPES[label]
        elif is_first and (label == "intro" or mean < median):
            types[index] = "intro"
        elif is_last and mean < median:
            types[index] = "outro"
        elif mean <= quiet or (label == "break" and mean < median):
            types[index] = "breakdown"
        elif upcoming is not None and upcoming > mean and (
            upcoming >= mean + 0.15 or (second - first >= 0.15 and upcoming >= median)
        ):
            # Climbs into something louder: either the next section is much
            # louder, or the energy rises clearly within this passage itself.
            types[index] = "build"
        elif label == "intro":
            types[index] = "interlude"
        else:
            types[index] = "instrumental"

    # A build that starts earlier: extend it back over quieter passages of the
    # same model label that already climb towards it.
    for index in range(len(units) - 1, 0, -1):
        previous = index - 1
        if (
            types[index] == "build"
            and types[previous] in {"interlude", "instrumental", "breakdown"}
            and units[previous]["label"] == units[index]["label"]
            and means[previous] < means[index]
        ):
            types[previous] = "build"
    for index in range(len(units) - 1):
        length = units[index]["endBar"] - units[index]["startBar"] + 1
        if types[index] in {"build", "interlude", "verse"} and types[index + 1] == "chorus" and length <= 8:
            if types[index] != "verse" or means[index + 1] >= means[index] + 0.15:
                types[index] = "prechorus"
    return [kind or "instrumental" for kind in types]


def motif_similarity_matrix(chroma, mfcc, chord_names: list[str], energy, length: int):
    """Similarity of every pair of `length`-bar windows, as one matrix.

    For windows starting at bars i and j: 0.58 × chroma cosine + 0.20 × MFCC
    cosine (mapped to 0..1) + 0.14 × share of bars with the same chord name +
    0.08 × (1 − mean energy difference).
    """
    np = import_numpy()
    windows = len(chord_names) - length + 1

    def cosine(features):
        stacked = np.stack([features[offset:offset + windows] for offset in range(length)], axis=1).reshape(windows, -1)
        norms = np.linalg.norm(stacked, axis=1)
        return (stacked @ stacked.T) / (np.outer(norms, norms) + 1e-9)

    chroma_score = cosine(np.asarray(chroma))
    mfcc_score = np.clip((cosine(np.asarray(mfcc)) + 1.0) / 2.0, 0.0, 1.0)
    codes = np.unique(np.asarray(chord_names), return_inverse=True)[1]
    energy = np.asarray(energy, dtype=float)
    chord_score = np.zeros((windows, windows))
    energy_gap = np.zeros((windows, windows))
    for offset in range(length):
        window_codes = codes[offset:offset + windows]
        window_energy = energy[offset:offset + windows]
        chord_score += window_codes[:, None] == window_codes[None, :]
        energy_gap += np.abs(window_energy[:, None] - window_energy[None, :])
    return 0.58 * chroma_score + 0.20 * mfcc_score + 0.14 * chord_score / length + 0.08 * (1.0 - energy_gap / length)


def build_detected_sections(segments: list[dict], fold: dict | None, bar_energy: list[float]) -> list[dict]:
    """Name this song's sections with standard section types.

    Sections follow the model's segment boundaries; neighbouring segments that
    get the same type are merged. Repeated types are numbered (Verse 1, Verse 2).
    """
    units = section_units(segments)
    if not units:
        return []
    types = classify_sections(units, bar_energy)
    merged: list[dict] = []
    for unit, kind in zip(units, types):
        if merged and merged[-1]["type"] == kind:
            merged[-1]["endBar"] = unit["endBar"]
            merged[-1]["labels"].add(unit["label"])
        else:
            merged.append({"type": kind, "startBar": unit["startBar"], "endBar": unit["endBar"], "labels": {unit["label"]}})

    totals: dict[str, int] = {}
    for section in merged:
        totals[section["type"]] = totals.get(section["type"], 0) + 1
    counts: dict[str, int] = {}
    fold_boundaries = [segment["start"] for segment in fold["segments"][1:]] if fold else []
    sections = []
    for index, section in enumerate(merged):
        kind = section["type"]
        counts[kind] = counts.get(kind, 0) + 1
        name, short = SECTION_TYPES[kind]
        if totals[kind] > 1:
            name = f"{name} {counts[kind]}"
            short = f"{short} {counts[kind]}"
        start = 0.0 if section["startBar"] == 1 else bar_start(section["startBar"])
        end = TRACK_DURATION if index == len(merged) - 1 else bar_start(section["endBar"] + 1)
        sections.append({
            "name": name,
            "short": short,
            "type": kind,
            "colorKey": kind,
            "start": round(start, 3),
            "end": round(end, 3),
            "startBar": section["startBar"],
            "endBar": section["endBar"],
            "source": "model+energy",
            "secondarySupport": section["startBar"] == 1
            or any(abs(candidate - start) <= 0.75 for candidate in fold_boundaries),
            "modelLabels": sorted(section["labels"]),
        })
    return sections


def prepare_browser_data() -> dict:
    result = json.loads(RESULT.read_text())
    fold = json.loads(FOLD_RESULT.read_text()) if FOLD_RESULT.exists() else None
    chord_analysis = analyze_chords(result)
    audio_events = analyze_audio_events(result, chord_analysis)
    fold_boundaries = [segment["start"] for segment in fold["segments"][1:]] if fold else []
    segments = []
    for index, segment in enumerate(result["segments"]):
        start_bar = nearest_bar(segment["start"])
        if index + 1 < len(result["segments"]):
            end_bar = max(start_bar, nearest_bar(segment["end"]) - 1)
        else:
            end_bar = TOTAL_BARS
        segments.append({
            "start": segment["start"],
            "end": min(segment["end"], TRACK_DURATION),
            "label": segment["label"],
            "startBar": start_bar,
            "endBar": min(end_bar, TOTAL_BARS),
        })

    boundaries = []
    for previous, upcoming in zip(segments, segments[1:]):
        time = upcoming["start"]
        if time <= 0.01 or time >= TRACK_DURATION - 0.01:
            continue
        boundaries.append({
            "time": time,
            "bar": nearest_bar(time),
            "from": previous["label"],
            "to": upcoming["label"],
            "secondarySupport": any(abs(candidate - time) <= 0.75 for candidate in fold_boundaries),
        })

    detected_sections = build_detected_sections(segments, fold, audio_events["barEnergy"])

    return {
        "version": 2,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "track": {
            "name": TRACK_NAME,
            "duration": TRACK_DURATION,
            "source": SOURCE_MP3.name,
            "barOne": BAR_ONE,
            "barDuration": BAR_DURATION,
            "totalBars": TOTAL_BARS,
            "timeSignature": "4/4",
        },
        "analyzer": {
            "name": "All-In-One-Infer",
            "version": "3.1.0",
            "model": "harmonix-all",
            "bpm": result["bpm"],
            "beatCount": len(result["beats"]),
            "downbeatCount": len(result["downbeats"]),
        },
        "beats": result["beats"],
        "downbeats": result["downbeats"],
        "segments": segments,
        "boundaries": boundaries,
        "detectedSections": detected_sections,
        "chordAnalysis": chord_analysis,
        "barEnergy": audio_events["barEnergy"],
        "turnAnalysis": audio_events["turnAnalysis"],
        "motifAnalysis": audio_events["motifAnalysis"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze one song for HitMapper")
    parser.add_argument("--source", type=Path, required=True, help="source audio file")
    parser.add_argument("--work", type=Path, required=True, help="isolated analysis workspace")
    parser.add_argument("--output", type=Path, required=True, help="browser-ready JSON output")
    parser.add_argument("--track-name", help="display name")
    args = parser.parse_args()
    configure_paths(args.source, args.work, args.output, args.track_name)
    if not SOURCE_MP3.exists():
        raise SystemExit(f"Missing source audio: {SOURCE_MP3}")
    ensure_wav()
    ensure_analysis()
    configure_timing(json.loads(RESULT.read_text()))
    ensure_marker_audio()
    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    payload = prepare_browser_data()
    OUTPUT_JSON.write_text(json.dumps(payload, indent=2) + "\n")
    print(
        f"Prepared {len(payload['segments'])} model segments, "
        f"{len(payload['boundaries'])} boundaries, {len(payload['detectedSections'])} macro sections, "
        f"{len(payload['chordAnalysis']['runs'])} chord runs, "
        f"{len(payload['turnAnalysis']['candidates'])} transition candidates, and "
        f"{len(payload['motifAnalysis']['groups'])} repeat groups."
    )
    print(f"Browser data: {OUTPUT_JSON}")
    print(f"Marker audio: {MARKERS_MP3}")


if __name__ == "__main__":
    main()
