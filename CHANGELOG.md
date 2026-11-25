# Changelog

All notable changes to HitMapper are documented here.

## 1.0.0 — 2026-11-25

First public release. HitMapper started as a single-song prototype and became
a Docker app with a song library, uploads and per-song analysis; this release
turns it into a standalone project.

- **Sections named for each song.** Sections follow the model's segments
  and are named with standard types: the model's verse, chorus, bridge,
  solo and outro are kept, and other passages are named from their energy
  and context (Intro, Build, Pre-chorus, Breakdown, Interlude,
  Instrumental, Outro), numbered when they repeat. Before, every song was
  fitted to one arrangement arc (First peak, Breakdown, Rebuild, Second
  peak…), which suited one song and could turn a whole track into a
  single "Intro". Maps already saved keep their names until re-analysed.
- **Chords: stems are tuned too.** The tuning estimate was applied to the
  mix only, because it was made after the stems' chroma; the mix now goes
  first. Chord and feature caches move to version 4, so a re-analysis
  recomputes them.
- **Faster repeat detection** on long songs: every pair of bar windows is
  compared in one matrix operation (same formula, tested).
- **Smaller Docker image:** a two-stage build keeps compilers, git and
  FFTW headers out of the final image, the base image is pinned to Debian
  trixie, and only the app's own files are copied in.
- **The page works with site storage blocked or full**; notes, zoom and
  section edits simply aren't saved then (before, the page didn't start).
- **Saved edits belong to one song.** Notes, zoom and section edits are now
  kept per song (by project), not per file type and length, so two mixes of
  the same length no longer share them. Existing edits are copied across
  once; the old keys stay. Notes can only be typed once a song is open.
- **One bar grid for browser and analysis.** A downbeat counts only when a
  neighbouring downbeat is about one bar away (within 10%), so a free or
  slower intro stays on the nominal grid; missing bars between detected
  downbeats are filled in, and bar starts always increase. The pipeline
  uses the same rule, so chords and energy are measured on the bars you
  see. Saved maps play back on exactly the same grid as before (checked on
  two songs).
- **Damaged or unusual maps no longer freeze the display:** sections, chord
  bars and energy are checked and repaired on load, and the page says "No
  chords detected" or "No model segments" instead of waiting forever.
- **Keyboard:** shortcuts no longer fire twice, with Cmd/Ctrl/Alt held, in
  text fields, or while the song dialog is open. Each ribbon lane is one tab
  stop (arrow keys move within it) instead of one per block.
- **New section colours** for each section type; maps saved earlier keep
  their colours. The page no longer shows one song's data as placeholders
  before a song loads.
- **Smoother playback display:** per-frame work only runs when the bar,
  beat or section changes; hovering and dragging no longer re-measure or
  redraw everything.
- **Fixes:** job polling stops when a song is gone; if marker audio fails to
  load the original audio comes back; looping the last section keeps
  looping; dead code and CSS removed.
- **Out-of-memory failures are explained.** The structure model's memory
  grows with song length; a 7-minute song needed more than Docker Desktop's
  default of about 8 GB and was killed (even a single model of the
  ensemble); with 24 GB it peaked at about 8.7 GB and took 2½ minutes. HitMapper now says the analysis ran out of memory and how to
  give Docker more, and the README states the requirement.
- **Wheel labels fit their sections.** A label is shrunk (and, if it still
  doesn't fit, shortened with an ellipsis) instead of being clipped at both
  ends; this also covers long names you give sections yourself. Section
  short labels are full words where they fit (Chorus, Breakdown,
  Pre-chorus).
- **From an independent review of the front end:** section edits saved in
  the oldest format are applied again (they were migrated but ignored);
  notes typed with no song open in older versions go to the first song
  opened; a song with a single section draws its whole ring (the circle
  used to vanish); shortcuts keep working after using the playback slider;
  labels stay fitted while a divider is dragged; Rename changes the section
  shown when you started typing, even if playback moves on; and a damaged
  map can't claim more bars than fit in the song. Checked in headless
  Chrome with planted old-format data.
- **Verified in Docker:** the reviewed build analysed a 7-minute song end to
  end; against the map an earlier version made of the same song, the model
  timing, energy and repeats are identical, 164 of 167 chord bars match
  (three refined), one more transition was found, and the sections carry
  the new names. Checked in the browser and in headless Chrome at
  1920×1080.
- **No built-in demo song.** The analysis pipeline always analyses the song it
  is given (`--source`, `--work` and `--output` are required). The prototype's
  default track, paths, timing constants and bundled analysis are gone.
- **Older interfaces removed:** `/api/active/*`, `/api/projects/<id>/activate`,
  `state.json` and the `/HitMapper` redirect. The browser already used the
  per-project URLs, so libraries and saved maps keep working. New maps no
  longer contain the unused `audioUrl` and `markerAudioUrl` entries.
- **The server serves only the app's own files** (`index.html`, `app.js`,
  `styles.css`) and project files by ID. Before, it would serve any file in
  its folder, including its source code and, in a native setup, the song
  library under `.runtime-data/`.
- **This computer only by default.** Docker publishes port 8766 on
  `127.0.0.1`, and the native server binds `127.0.0.1` unless
  `HITMAPPER_HOST` is set. Before, anyone on the network could open
  HitMapper and upload songs. The README explains how to allow network access.
- **Only HitMapper's own page can use it.** The server refuses requests with
  another host name (so a DNS-rebinding page can't read your library) and
  POSTs from other websites (so a page you visit can't upload or retry
  songs). Names for network access go in `HITMAPPER_ALLOWED_HOSTS`.
- **Song files with non-Latin names upload.** A name such as `Песня.wav` was
  refused as an unsupported type, because the extension was read after
  non-ASCII characters were stripped; its name is now kept as the default
  song name.
- **An interrupted upload leaves nothing behind** (the partial file and its
  folder are removed).
- **Missing marker audio no longer fails the analysis**; the map is built
  and marker playback is simply unavailable for that song.
- **`HITMAPPER_ANALYZER`** now takes precedence over an `all-in-one-infer`
  found on `PATH`.
- **Launcher:** `Start HitMapper Docker.command` starts Docker Desktop when it
  isn't running and waits for HitMapper before opening the browser. It no
  longer looks for the prototype's preview server.
- **Clearer messages:** a missing analyzer says to use Docker or install
  `requirements.txt`; a playback error no longer mentions the prototype's folder.
- **Fix:** each analysis left its output pipe open until garbage collection;
  the server now closes it.
- **Tests:** 22 automated tests (`tests/`) for uploads, served files, host and
  origin checks, jobs, retries and resuming, and the pipeline's grid,
  sections and analyzer choice. They need Flask and ffmpeg only
  (`requirements-test.txt`).
- **Verified:** all tests pass; the native server (no audio models) serves
  only the page and its two files, listens on 127.0.0.1, and reports a failed
  analysis with its log. In Docker, rebuilt over an existing library: the
  saved songs stay ready, a saved map opens, plays, seeks and serves marker
  audio with no console errors, other host names get 403, and a new upload
  (a synthetic 32-second song at 120 BPM with a C–F–G–C bar cycle) analyses
  to the right tempo, bar grid and chords and opens in the browser.
- **README screenshots** of a full map and the zoomed session ribbon.
- **Docs:** README additions (privacy, network access, tests, credits and
  model licences); the development guide moves from `AGENTS.md` to
  `docs/DEVELOPMENT.md`; `CLAUDE.md` and an MIT `LICENSE` added.
