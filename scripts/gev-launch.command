#!/bin/bash
# God's Eye View — double-click launcher for macOS.
#
# Starts the app (or reuses one already running) and opens it in its own
# window. Close this Terminal window, or press Ctrl+C, to stop it.
#
# Uses what is already on the Mac and shared with other projects: Node from
# nvm, and Ollama for Local AI voice. Project packages install only when they
# are missing or changed. The Ollama model is not loaded here; Ollama loads it
# the first time voice uses it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
cd "$ROOT_DIR"
PORT="${PORT:-4173}"
URL="http://localhost:${PORT}/"

say() { printf '\n▸ %s\n' "$*"; }

open_app() {
  # Its own window, without browser tabs or toolbars, when Chrome is installed.
  if [[ -d "/Applications/Google Chrome.app" ]]; then
    open -na "Google Chrome" --args --app="$URL"
  else
    open "$URL"
  fi
}

# Already running? Just open it.
if curl -sf -o /dev/null "$URL"; then
  say "God's Eye View is already running."
  open_app
  exit 0
fi

# Node 24 (or 26) from nvm; other versions are not supported by the project.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
for nvm_script in "$NVM_DIR/nvm.sh" /opt/homebrew/opt/nvm/nvm.sh /usr/local/opt/nvm/nvm.sh; do
  if [[ -s "$nvm_script" ]]; then
    # shellcheck source=/dev/null
    source "$nvm_script"
    break
  fi
done
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [[ "$(node_major)" != 24 && "$(node_major)" != 26 ]]; then
  if ! command -v nvm >/dev/null 2>&1; then
    echo "Node 24 is needed and nvm was not found. Install nvm, then run: nvm install 24"
    read -r -p "Press Return to close."
    exit 1
  fi
  say "Switching to Node 24 (installing it once if needed)…"
  nvm use 24 >/dev/null 2>&1 || nvm install 24
  nvm use 24 >/dev/null
fi
echo "Node $(node -v)"

# Project packages: only when missing or when package-lock.json changed.
if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
  say "Installing project packages (first run or after an update)…"
  # The test browser Puppeteer would download is not needed to use the app.
  PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund
fi

# Ollama for Local AI voice: start the app if it is installed but not running.
if ! curl -sf -o /dev/null http://127.0.0.1:11434/api/tags; then
  if [[ -d /Applications/Ollama.app ]]; then
    say "Starting Ollama…"
    open -ga Ollama
  else
    echo "Ollama is not running; Local AI voice will be unavailable until it is."
  fi
fi

say "Starting God's Eye View at $URL"
echo "Leave this window open while you use it. Close it (or press Ctrl+C) to stop."
(
  for _ in $(seq 1 90); do
    sleep 1
    if curl -sf -o /dev/null "$URL"; then
      open_app
      exit 0
    fi
  done
) &
exec npm run dev -- --port "$PORT" --strictPort
