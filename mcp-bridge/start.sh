#!/usr/bin/env bash
set -e
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not installed or not on PATH. Install Node.js 18+ from https://nodejs.org" >&2
  exit 1
fi
PORT="${ATTK_PORT:-8765}"
DIR="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="$DIR/certs"
if command -v openssl >/dev/null 2>&1 && [ ! -f "$CERT_DIR/localhost-key.pem" ]; then
  mkdir -p "$CERT_DIR"
  openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
    -keyout "$CERT_DIR/localhost-key.pem" -out "$CERT_DIR/localhost-cert.pem" \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
  chmod 600 "$CERT_DIR/localhost-key.pem"
  echo "Generated self-signed WSS certificate in $CERT_DIR (trust it once in Chrome if prompted)."
fi
echo "Starting Specter bridge on port $PORT (WSS: ${SPECTER_WSS_PORT:-$((PORT + 1))})..."
exec node "$DIR/bridge.js"
