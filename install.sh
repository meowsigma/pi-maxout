#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXTENSIONS_DIR="$AGENT_DIR/extensions"
DEST="$EXTENSIONS_DIR/pi-maxout"
STAGE="$EXTENSIONS_DIR/.pi-maxout-stage-$$"
BACKUP=""
COMMITTED=0

cleanup() {
  rm -rf "$STAGE"
  if [[ "$COMMITTED" -eq 0 && -n "$BACKUP" && -e "$BACKUP" && ! -e "$DEST" ]]; then
    mv "$BACKUP" "$DEST" || true
  fi
}
trap cleanup EXIT

command -v node >/dev/null 2>&1 || {
  echo "ERROR: Node.js is required." >&2
  exit 1
}

echo "Running bundled tests..."
node --test "$SRC_DIR/tests/core.test.mjs"

mkdir -p "$EXTENSIONS_DIR" "$STAGE"
cp "$SRC_DIR/index.ts" "$STAGE/index.ts"
cp "$SRC_DIR/core.mjs" "$STAGE/core.mjs"
cp "$SRC_DIR/core.d.mts" "$STAGE/core.d.mts"
cp "$SRC_DIR/README.md" "$STAGE/README.md"

if [[ -e "$DEST" ]]; then
  BACKUP="${DEST}.backup-$(date +%Y%m%d-%H%M%S)-$$"
  mv "$DEST" "$BACKUP"
fi

mv "$STAGE" "$DEST"
COMMITTED=1
trap - EXIT

printf 'Installed pi-maxout v1.0.0 to:\n  %s\n' "$DEST"
if [[ -n "$BACKUP" ]]; then
  printf 'Previous extension backed up to:\n  %s\n' "$BACKUP"
fi
cat <<'MSG'

Restart Pi or run /reload, then use:
  /maxout
  /maxout 32k
  /maxout save 32k
  /maxout auto
MSG
