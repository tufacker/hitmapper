# HitMapper development guide

HitMapper charts a recording the way a session musician might sketch it on a first listen. The browser is a studio display and an editing workspace. Use [README.md](../README.md) for startup, everyday use, and troubleshooting.

## Where to work

- `index.html` and `styles.css` define the library, arrangement wheel, live cards, transport, and session ribbon. `app.js` renders the SVG wheel and ribbon, synchronizes them with the audio element, and handles seeking, editing, library navigation, and job polling. The browser uses plain HTML, CSS, and JavaScript with no build step.
- `server.py` serves the page (`index.html`, plus only `app.js` and `styles.css` from the app folder) and project files, validates multipart uploads with `ffprobe`, and runs one analyzer subprocess at a time. It stores job status in `project.json` and requeues interrupted jobs on startup. The Docker configuration uses one Gunicorn worker because the queue and its locks are in-process.
- `analysis_pipeline.py` converts the source with FFmpeg, runs All-In-One-Infer (`harmonix-all`) for timing and structure, combines deep chroma from the pinned `madmom-modern` dependency with librosa and stem evidence for chords, and derives energy, transitions, and repeats. Start with `configure_timing`, `build_detected_sections`, `analyze_chords`, `analyze_audio_events`, and `prepare_browser_data` for changes to the chart.
- `compose.yaml`, `Dockerfile`, and `requirements.txt` define the supported runtime. The Dockerfile builds the Python environment in a first stage (with compilers and git) and copies only that environment and the five app files into a slim runtime image. Keep the neural chord dependency in the image. The pipeline imports `madmom`; the separate `madmom-infer` dependency used by All-In-One-Infer is a different package.
- The pipeline always takes `--source`, `--work` and `--output` (and optionally `--track-name`); the server runs it once per upload. For direct pipeline experiments, use a scratch work directory.
- `tests/` holds the automated tests (`unittest`): the server with a fake analyzer, and the pipeline's grid and section logic. They need Flask and ffmpeg, not the audio models.

## Request flow and saved data

1. `GET /api/status` populates the library and reports pending work. `/` opens the chooser with no song loaded. `/?song=<project-id>` selects an explicit project.
2. `POST /api/tracks` accepts multipart `song` and optional `name`, returns `202`, and saves the upload before queueing analysis. The browser polls `GET /api/jobs/<project-id>` through `queued` and `analyzing` to `ready` or `failed`. `POST /api/projects/<project-id>/retry` reuses a failed project’s upload and work directory.
3. For a selected project, `GET /api/projects/<project-id>/analysis` returns the chart. The `/audio` and `/markers` endpoints under the same project path serve the original and annotated audio. Maps saved by older versions may still contain `audioUrl` and `markerAudioUrl` entries pointing at `/api/active/*`; the browser ignores them.

`prepare_browser_data()` produces the saved `analysis.json`. Its top-level version is `2`. `track` describes duration and the nominal bar grid. `beats`, `downbeats`, `segments`, and `boundaries` describe model timing and structure. `detectedSections` drives the editable arrangement, `chordAnalysis.bars` and `.runs` drive chord displays, and `barEnergy`, `turnAnalysis.candidates`, and `motifAnalysis.groups` drive the other lanes. Times are in seconds, bar numbers start at 1, and bar-range ends are inclusive. `barEnergy[0]` describes bar 1. The current chart assumes four beats per bar.

When changing the analysis format, check `buildModelLane()` in `app.js` and account for maps already saved in the volume. Chord and audio-event caches in each project’s `work/` directory have their own versions (`CHORD_CACHE_VERSION`, `FEATURE_CACHE_VERSION`) and freshness checks; bump the version when an algorithm change should replace cached results. Keep saved audio and maps when rebuilding. Use a separate data directory or scratch project for experiments that regenerate files.

### Section names

`build_detected_sections()` names each song's sections from standard types (`SECTION_TYPES`): Intro, Verse, Pre-chorus, Chorus, Bridge, Solo, Instrumental, Build, Breakdown, Interlude, Outro. It never assumes a song shape:

1. `section_units()` turns the model's segments (minus `start`/`end`) into contiguous bar ranges and folds segments shorter than two bars into a neighbour.
2. `classify_sections()` keeps the model's `verse`, `chorus`, `bridge`, `solo` and `outro`. Passages it calls `intro`, `inst` or `break` are named from bar energy and context: the first quiet passage is the Intro; a quiet last passage the Outro; a passage clearly quieter than the song's usual level a Breakdown; one that climbs into something louder a Build (extended back over quieter passages of the same label that lead up to it); a short build or interlude straight into a chorus a Pre-chorus; otherwise Interlude (`intro` mid-song) or Instrumental.
3. Neighbouring units of the same type merge; repeated types are numbered (Verse 1, Verse 2).

Each section's `colorKey` is its type. Maps saved by earlier versions use older keys (`opening`, `peak`, `breakdown`, `rebuild`, `develop`); the browser still colours them. Tests in `tests/test_pipeline.py` cover a verse/chorus song, an instrumental track, builds and pre-choruses.

For a missed or misplaced section, compare `detectedSections`, the raw `segments`, `barEnergy` and `turnAnalysis.candidates` at the same bar. Listening around the boundary helps establish whether the problem is model detection, how the passages were classified, or how the result is timed in the browser.

Notes, zoom, and section edits are stored in `localStorage` for the browser origin. `applyTrackMetadata()` derives keys from source/name and duration. The stored section list applies on top of detected defaults. Preserve compatible keys or migrate them when changing storage, and keep sections contiguous from bar 1 to the end of the track. A Docker volume backup covers recordings and generated maps. Back up browser data separately if session edits or notes need to move.

## Behavior to preserve

- The same section state drives the wheel and editable ribbon. Divider drags snap to whole bars and update both views immediately. Raw model segments remain visible in the AI lane. Wheel section labels follow the curve and stay upright. The active section uses color on its existing shape.
- The wheel, ribbon, and live chord displays use the analyzed chord chart. The ribbon’s chord blocks reveal details on hover or focus, and individual energy bars stay visually separated. Transition markers and repeat groups are analysis candidates. Keep automatic boundaries, chords, and motifs derived from audio and models. Validate detection changes across full tracks.
- Playback uses `audio.currentTime` and the corrected musical grid. Check the current bar highlight, both countdowns, and the center progress bar together around a downbeat. Positions use `bar.beat` such as `1.1` and `2.1`. Coming Up shows chord and section only, with fixed-width whole-beat counts and yellow at eight beats, red at four. The wheel’s center bar empties in beat steps before the next chord.
- Keep the studio layout readable at 1920×1080 and preserve the information available in the wheel and ribbon. A fresh visit to `/` should show the library without fetching any song’s chart or audio.

## Verify a change

From the HitMapper folder, use the checks relevant to the change:

```bash
node --check app.js
python3 -m py_compile server.py analysis_pipeline.py
.venv/bin/python -m unittest discover -s tests   # after: python3 -m venv .venv && .venv/bin/pip install -r requirements-test.txt
docker compose config --quiet
docker compose up --build -d
curl -fsS http://127.0.0.1:8766/api/status
```

- Open `/`, select a ready song, and try play, seek, and marker audio. For timing or editing changes, check a known section/chord boundary, drag or rename a section, and reload to confirm the wheel, ribbon, and saved edit agree.
- For server or analyzer changes, upload a short test recording you have permission to use and wait for `ready`. Confirm its map opens, plays, and reappears in the library after a reload. A passing `/api/status` health check only confirms the server is responding. For failures, inspect the job status and the project’s `analysis.log` as described in the README.

## Security model

HitMapper has no accounts or login. It is meant for one person on their own computer:

- Docker publishes the port on `127.0.0.1` only, and the native server binds `127.0.0.1` unless `HITMAPPER_HOST` says otherwise.
- Other web pages in the same browser can still reach `127.0.0.1`. The server refuses requests whose `Host` isn't `127.0.0.1`, `localhost`, `::1` or a name in `HITMAPPER_ALLOWED_HOSTS` (against DNS rebinding), and POSTs whose `Origin` isn't its own (against cross-site form posts).
- The server serves `index.html`, `app.js` and `styles.css`, and project files only by their hexadecimal project ID. Keep it that way: never serve the app folder or the data folder as a whole.
- Uploads are checked by extension and with `ffprobe`, limited by `HITMAPPER_MAX_UPLOAD_MB` (default 500), and stored under a generated name.

