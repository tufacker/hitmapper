"""Pipeline tests: the musical grid and the arrangement sections.

These parts of analysis_pipeline.py need only the standard library; the audio
models and librosa are not imported.
    python -m unittest discover -s tests
"""

import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import analysis_pipeline as pipeline  # noqa: E402


def set_timing(result, duration):
    probe = SimpleNamespace(stdout="%s\n" % duration)
    with mock.patch.object(pipeline.subprocess, "run", return_value=probe):
        pipeline.configure_timing(result)


class PathTests(unittest.TestCase):
    def test_each_song_gets_its_own_workspace(self):
        pipeline.configure_paths(Path("/songs/My_Song-Final.wav"), Path("/tmp/work"), Path("/tmp/out.json"), None)
        self.assertEqual(pipeline.TRACK_STEM, "My_Song-Final")
        self.assertEqual(pipeline.TRACK_NAME, "My Song Final")
        self.assertEqual(pipeline.SOURCE_WAV, Path("/tmp/work/My_Song-Final.wav").resolve())
        self.assertEqual(pipeline.OUTPUT_JSON, Path("/tmp/out.json").resolve())
        pipeline.configure_paths(Path("/songs/a.wav"), Path("/tmp/work"), Path("/tmp/out.json"), "Named")
        self.assertEqual(pipeline.TRACK_NAME, "Named")

    def test_a_configured_analyzer_wins_over_one_on_path(self):
        with mock.patch.dict(pipeline.os.environ, {"HITMAPPER_ANALYZER": "/opt/test/all-in-one-infer"}), \
                mock.patch.object(pipeline.shutil, "which", return_value="/usr/bin/all-in-one-infer"):
            pipeline.configure_paths(Path("/songs/a.wav"), Path("/tmp/work"), Path("/tmp/out.json"), None)
        self.assertEqual(pipeline.ANALYZER, Path("/opt/test/all-in-one-infer"))

    def test_missing_marker_audio_is_skipped(self):
        pipeline.configure_paths(Path("/songs/a.wav"), Path("/nonexistent/work"), Path("/tmp/out.json"), None)
        with mock.patch.object(pipeline, "run") as run:
            pipeline.ensure_marker_audio()
        run.assert_not_called()

    def test_the_command_line_needs_a_song(self):
        result = subprocess.run([sys.executable, str(ROOT / "analysis_pipeline.py")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--source", result.stderr)


class TimingTests(unittest.TestCase):
    def test_grid_from_downbeats(self):
        # 120 BPM in 4/4: a bar every 2 s, first downbeat detected at 5 s.
        set_timing({"downbeats": [5.0 + 2.0 * i for i in range(40)], "bpm": 120}, 100.0)
        self.assertAlmostEqual(pipeline.BAR_DURATION, 2.0)
        self.assertAlmostEqual(pipeline.BAR_ONE, -1.0, msg="projected back from 5 s, kept near the start")
        self.assertEqual(pipeline.TOTAL_BARS, 50)
        self.assertEqual(pipeline.TRACK_DURATION, 100.0)

    def test_grid_from_tempo_when_there_are_no_downbeats(self):
        set_timing({"downbeats": [], "bpm": 120}, 101.0)
        self.assertEqual((pipeline.BAR_DURATION, pipeline.BAR_ONE, pipeline.TOTAL_BARS), (2.0, 0.0, 51))

    def test_bars_are_numbered_from_one_and_clamped(self):
        set_timing({"downbeats": [0.0, 2.0, 4.0], "bpm": 120}, 20.0)
        self.assertEqual(pipeline.nearest_bar(-5), 1)
        self.assertEqual(pipeline.nearest_bar(2.1), 2)
        self.assertEqual(pipeline.nearest_bar(999), pipeline.TOTAL_BARS)
        self.assertEqual(pipeline.bar_start(1), 0.0)

    def test_detected_downbeats_correct_the_bar_starts(self):
        set_timing({"downbeats": [0.0, 2.0, 4.0], "bpm": 120}, 20.0)
        starts = pipeline.corrected_bar_starts([0.0, 2.1, 4.2])
        self.assertEqual(starts[2], 2.1)
        self.assertEqual(starts[3], 4.2)
        self.assertAlmostEqual(starts[4], 6.3, msg="later bars follow the detected spacing")
        self.assertEqual(starts[pipeline.TOTAL_BARS + 1], 20.0)


def energy_for(*spans):
    """Bar energy from (bars, level) or (bars, start_level, end_level) spans."""
    values = []
    for span in spans:
        bars, first, last = (span[0], span[1], span[1]) if len(span) == 2 else span
        values.extend(first + (last - first) * index / max(1, bars - 1) for index in range(bars))
    return values


class GridRuleTests(unittest.TestCase):
    def test_an_unsteady_opening_stays_on_the_nominal_grid_and_gaps_are_filled(self):
        # Nominal 2 s bars. The opening downbeats are 3 s apart (a slower, free
        # intro) and must not pull bars together; from bar 6 on they are steady,
        # with bar 8's downbeat missing.
        downbeats = [0.0, 3.0, 6.0] + [10.0, 12.0, 16.0, 18.0, 20.0]
        set_timing({"downbeats": [2.0 * i for i in range(12)], "bpm": 120}, 24.0)
        starts = pipeline.corrected_bar_starts(downbeats)
        self.assertEqual(starts[2], 2.0, "the 3 s-spaced opening is ignored")
        self.assertEqual(starts[6], 10.0)
        self.assertEqual(starts[8], 14.0, "a missing downbeat is interpolated")
        self.assertTrue(all(b > a for a, b in zip(starts[1:], starts[2:])), "strictly increasing")
        self.assertEqual(starts[pipeline.TOTAL_BARS + 1], 24.0)


class SectionTests(unittest.TestCase):
    def sections(self, spans, energy):
        """spans: (label, bars) in order; the grid is 2 s per bar."""
        total = sum(bars for _, bars in spans)
        set_timing({"downbeats": [2.0 * i for i in range(total)], "bpm": 120}, 2.0 * total)
        segments, bar = [], 1
        for label, bars in spans:
            segments.append({"label": label, "start": 2.0 * (bar - 1), "end": 2.0 * (bar + bars - 1),
                             "startBar": bar, "endBar": bar + bars - 1})
            bar += bars
        sections = pipeline.build_detected_sections(segments, None, energy)
        self.assertEqual(sections[0]["startBar"], 1)
        self.assertEqual(sections[-1]["endBar"], pipeline.TOTAL_BARS)
        for previous, upcoming in zip(sections, sections[1:]):
            self.assertEqual(previous["endBar"] + 1, upcoming["startBar"], (previous["name"], upcoming["name"]))
        return sections

    def test_a_verse_chorus_song_keeps_the_models_names_numbered(self):
        spans = [("intro", 8), ("verse", 16), ("chorus", 8), ("verse", 16), ("chorus", 8), ("bridge", 8), ("chorus", 8), ("outro", 8)]
        energy = energy_for((8, .2), (16, .5), (8, .9), (16, .5), (8, .9), (8, .6), (8, .95), (8, .2))
        names = [s["name"] for s in self.sections(spans, energy)]
        self.assertEqual(names, ["Intro", "Verse 1", "Chorus 1", "Verse 2", "Chorus 2", "Bridge", "Chorus 3", "Outro"])

    def test_an_instrumental_track_is_split_by_its_energy(self):
        spans = [("inst", 12), ("inst", 8), ("inst", 9), ("inst", 12), ("inst", 8), ("inst", 8)]
        energy = energy_for((12, .65), (8, .66), (9, .25), (12, .65), (8, .66), (8, .3))
        sections = self.sections(spans, energy)
        self.assertEqual([s["name"] for s in sections], ["Instrumental 1", "Breakdown", "Instrumental 2", "Outro"])
        self.assertEqual([(s["startBar"], s["endBar"]) for s in sections], [(1, 20), (21, 29), (30, 49), (50, 57)])
        self.assertEqual([s["colorKey"] for s in sections], ["instrumental", "breakdown", "instrumental", "outro"])

    def test_climbing_passages_become_builds_and_a_short_one_before_a_chorus_a_pre_chorus(self):
        spans = [("intro", 8), ("intro", 8), ("intro", 8), ("inst", 8), ("intro", 6), ("chorus", 8), ("outro", 8)]
        energy = energy_for((8, .1), (8, .2, .3), (8, .3, .4), (8, .9), (6, .5, .7), (8, .95), (8, .1))
        names = [s["name"] for s in self.sections(spans, energy)]
        self.assertEqual(names, ["Intro", "Build", "Instrumental", "Pre-chorus", "Chorus", "Outro"])

    def test_very_short_segments_join_a_neighbour(self):
        spans = [("start", 1), ("intro", 7), ("verse", 1), ("verse", 8), ("end", 1)]
        energy = energy_for((8, .2), (9, .6), (1, .1))
        sections = self.sections(spans, energy)
        self.assertEqual([(s["name"], s["startBar"], s["endBar"]) for s in sections], [("Intro", 1, 8), ("Verse", 9, 18)])

    def test_no_content_means_no_sections(self):
        set_timing({"downbeats": [0.0, 2.0], "bpm": 120}, 4.0)
        segments = [{"label": "start", "start": 0, "end": 1, "startBar": 1, "endBar": 1},
                    {"label": "end", "start": 1, "end": 2, "startBar": 2, "endBar": 2}]
        self.assertEqual(pipeline.build_detected_sections(segments, None, [0.5, 0.5]), [])


class RepeatTests(unittest.TestCase):
    def test_matrix_matches_the_pairwise_formula(self):
        np = pipeline.import_numpy()
        rng = np.random.default_rng(7)
        bars = 24
        chroma = rng.random((bars, 12))
        mfcc = rng.normal(size=(bars, 8))
        chords = [rng.choice(["C", "F", "G", "Am"]) for _ in range(bars)]
        energy = rng.random(bars)

        def pairwise(first, second, length):
            def cos(a, b):
                return float(np.dot(a, b) / ((np.linalg.norm(a) * np.linalg.norm(b)) + 1e-9))
            chroma_score = cos(chroma[first:first + length].reshape(-1), chroma[second:second + length].reshape(-1))
            mfcc_score = np.clip((cos(mfcc[first:first + length].reshape(-1), mfcc[second:second + length].reshape(-1)) + 1) / 2, 0, 1)
            chord_score = sum(chords[first + k] == chords[second + k] for k in range(length)) / length
            energy_score = 1 - float(np.mean(np.abs(energy[first:first + length] - energy[second:second + length])))
            return 0.58 * chroma_score + 0.20 * mfcc_score + 0.14 * chord_score + 0.08 * energy_score

        for length in (2, 3, 4):
            matrix = pipeline.motif_similarity_matrix(chroma, mfcc, chords, energy, length)
            for first in range(bars - length + 1):
                for second in range(bars - length + 1):
                    self.assertAlmostEqual(matrix[first, second], pairwise(first, second, length), places=9)


if __name__ == "__main__":
    unittest.main()
