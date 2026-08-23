#!/usr/bin/env bash
set -e
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not installed or not on PATH. Install Node.js 18+ from https://nodejs.org" >&2
  exit 1
fi
PORT="${ATTK_PORT:-8765}"
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Starting Specter bridge on port $PORT..."
exec node "$DIR/bridge.js"
