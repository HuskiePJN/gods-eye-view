#!/bin/bash
# God's Eye View — double-click launcher for macOS.
#
# Starts the app and opens it in its own window. Closing that window shuts
# everything down: the app server stops, a local AI model loaded for voice is
# unloaded, Ollama quits if this launcher started it, and this Terminal
# window closes. Closing this Terminal window (or Ctrl+C) does the same.
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
OLLAMA_API="http://127.0.0.1:11434/api"
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# Its own Chrome profile, so the window is a separate Chrome that can be
# closed with the app without touching your normal browser windows.
CHROME_PROFILE="$HOME/Library/Application Support/God's Eye View/Chrome"

say() { printf '\n▸ %s\n' "$*"; }

open_app() {
  if [[ -x "$CHROME_BIN" ]]; then
    "$CHROME_BIN" --user-data-dir="$CHROME_PROFILE" --no-first-run \
      --no-default-browser-check --app="$URL" >/dev/null 2>&1 &
    CHROME_PID=$!
  else
    open "$URL"
  fi
}

# Already running from another launch? Just open a window; that launch owns
# the shutdown.
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
# Remember what was already loaded, so shutdown unloads only what we added.
loaded_models() {
  curl -sf "$OLLAMA_API/ps" | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const m of JSON.parse(s).models||[])console.log(m.name)}catch{}})' \
    2>/dev/null || true
}
STARTED_OLLAMA=0
if ! curl -sf -o /dev/null "$OLLAMA_API/tags"; then
  if [[ -d /Applications/Ollama.app ]]; then
    say "Starting Ollama…"
    open -ga Ollama
    STARTED_OLLAMA=1
  else
    echo "Ollama is not running; Local AI voice will be unavailable until it is."
  fi
fi
MODELS_BEFORE="$(loaded_models)"

SERVER_PID=""
CHROME_PID=""
shutdown() {
  trap - EXIT HUP INT TERM
  say "Shutting down God's Eye View…"
  [[ -n "$CHROME_PID" ]] && kill "$CHROME_PID" 2>/dev/null || true
  # The server runs in its own process group; stop all of it.
  [[ -n "$SERVER_PID" ]] && kill -TERM -- "-$SERVER_PID" 2>/dev/null || true
  if [[ "$STARTED_OLLAMA" == 1 ]]; then
    osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true
  else
    for model in $(loaded_models); do
      if ! grep -qxF "$model" <<<"$MODELS_BEFORE"; then
        curl -sf -o /dev/null "$OLLAMA_API/generate" \
          -d "{\"model\":\"$model\",\"keep_alive\":0}" || true
        echo "Unloaded $model from memory."
      fi
    done
  fi
  echo "Stopped. Nothing from God's Eye View is left running."
  # Close this Terminal window once the script has exited.
  local tty_name
  tty_name="$(tty 2>/dev/null || true)"
  if [[ "$tty_name" == /dev/* ]]; then
    nohup osascript -e "delay 1" -e "tell application \"Terminal\" to close (every window whose tty of tab 1 is \"$tty_name\")" \
      >/dev/null 2>&1 &
  fi
  exit 0
}
trap shutdown EXIT HUP INT TERM

say "Starting God's Eye View at $URL"
echo "Close the God's Eye View window to stop everything."
set -m # the server gets its own process group, so shutdown can stop all of it
npm run dev -- --port "$PORT" --strictPort &
SERVER_PID=$!
set +m

for _ in $(seq 1 90); do
  sleep 1
  curl -sf -o /dev/null "$URL" && break
done
open_app

# The app window holds connections to the server while it is open. When none
# have been open for 15 seconds (a reload takes far less), the window is gone.
connections() { lsof -nP -iTCP:"$PORT" -sTCP:ESTABLISHED 2>/dev/null | grep -c . || true; }
seen=0
idle=0
while kill -0 "$SERVER_PID" 2>/dev/null; do
  sleep 3
  if [[ "$(connections)" -gt 0 ]]; then
    seen=1
    idle=0
  elif [[ "$seen" == 1 ]]; then
    idle=$((idle + 3))
    [[ "$idle" -ge 15 ]] && break
  fi
done
