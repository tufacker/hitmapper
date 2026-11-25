# Notes for Claude

HitMapper: a local, Docker-based song-analysis web app (Flask server, one
analyzer subprocess per upload, plain HTML/CSS/JS front end). Start with
`README.md`, then `docs/DEVELOPMENT.md` (code map, API, data contract,
behaviour to preserve). If a private `CLAUDE_HANDOFF.md` exists in this
folder, read it first: it has the owner's standing rules and the current state.

## Working rules

- Run the checks in `docs/DEVELOPMENT.md` › "Verify a change" for what you
  changed; the unit tests (`python -m unittest discover -s tests`) always.
- The owner's song library lives in the `hitmapper-data` Docker volume. Never
  delete or overwrite it, and never run `docker compose down -v`. Rebuilding
  the container (`docker compose up --build -d`) keeps it, but ask first: it
  interrupts a running analysis.
- Experiment with a separate `HITMAPPER_DATA_DIR` or scratch project, and only
  upload recordings you have permission to use. No real songs, names or
  analysis output in tracked files.
- Keep the server serving only the page, `app.js`, `styles.css` and
  project files by hex ID, and listening on 127.0.0.1 by default.
- Keep `analysis.json` readable by maps saved earlier: when the format
  changes, check `buildModelLane()` and the saved maps in the volume.
- Behaviour counts as done only when seen working in the browser with a real
  map, not from tests alone.

## Keep the changelog current

Every change a user could notice, or a maintainer needs to know, gets a
`CHANGELOG.md` entry in the same commit, under `## Unreleased` at the top:

- one bullet per change: a short bold phrase, then the effect for the user,
  then the technical detail if it matters later;
- say when existing libraries, saved maps or browser data are affected, and how;
- say what was verified (tests, in Docker, in the browser) and what wasn't;
- never rewrite released sections except to correct them;
- at a release, rename `## Unreleased` to `## <version> — <date>`.
