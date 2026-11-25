#!/bin/zsh
# Double-click to start HitMapper in Docker and open it in the browser.
set -euo pipefail

APP_DIR="${0:A:h}"
URL="http://127.0.0.1:8766/"
cd "$APP_DIR"

pause() { read "?Press Return to close."; }

command -v docker >/dev/null || {
  print "Docker Desktop is required: https://www.docker.com/products/docker-desktop/"
  pause
  exit 1
}

if curl --silent --fail --max-time 1 "${URL}api/status" >/dev/null 2>&1; then
  open "$URL"
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  print "Starting Docker Desktop..."
  open -a Docker
  for _ in {1..90}; do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  docker info >/dev/null 2>&1 || {
    print "Docker Desktop didn't start. Start it yourself, then run HitMapper again."
    pause
    exit 1
  }
fi

port_pid="$(lsof -tiTCP:8766 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [[ -n "$port_pid" ]] && ! docker compose ps --status running --quiet 2>/dev/null | grep -q .; then
  print "Port 8766 is already in use by another application:"
  ps -p "$port_pid" -o command= 2>/dev/null || true
  print "Close it, then run HitMapper again."
  pause
  exit 1
fi

docker compose up --build -d
for _ in {1..60}; do
  curl --silent --fail --max-time 1 "${URL}api/status" >/dev/null 2>&1 && break
  sleep 1
done
open "$URL"
print "HitMapper is running at $URL"
print "Songs and analysis are stored in the hitmapper-data Docker volume."
