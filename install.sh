#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXTENSIONS_DIR="$AGENT_DIR/extensions"
DEST="$EXTENSIONS_DIR/pi-maxout"
# Never place a stage or backup containing index.ts under extensions/: Pi's
# recursive discovery would load it as a second live extension.
STAGE="$AGENT_DIR/.pi-maxout-stage-$$"
BACKUPS_DIR="$AGENT_DIR/backups/pi-maxout"
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
(
  cd "$SRC_DIR"
  node --experimental-strip-types --test
)

mkdir -p "$EXTENSIONS_DIR" "$BACKUPS_DIR" "$STAGE"
cp "$SRC_DIR/index.ts" "$STAGE/index.ts"
cp "$SRC_DIR/core.mjs" "$STAGE/core.mjs"
cp "$SRC_DIR/core.d.mts" "$STAGE/core.d.mts"
cp "$SRC_DIR/auto.mjs" "$STAGE/auto.mjs"
cp "$SRC_DIR/auto.d.mts" "$STAGE/auto.d.mts"
cp "$SRC_DIR/adaptive.mjs" "$STAGE/adaptive.mjs"
cp "$SRC_DIR/adaptive.d.mts" "$STAGE/adaptive.d.mts"
cp "$SRC_DIR/README.md" "$STAGE/README.md"

if [[ -e "$DEST" ]]; then
  BACKUP="$BACKUPS_DIR/pi-maxout-$(date +%Y%m%d-%H%M%S)-$$"
  mv "$DEST" "$BACKUP"
fi

mv "$STAGE" "$DEST"
COMMITTED=1
trap - EXIT

printf 'Installed pi-maxout v2.2.0 to:\n  %s\n' "$DEST"
if [[ -n "$BACKUP" ]]; then
  printf 'Previous extension backed up to:\n  %s\n' "$BACKUP"
fi
cat <<'MSG'

Restart Pi or run /reload, then use:
  /maxout
  /maxout 32k
  /maxout save 32k
  /maxout auto
  /maxout off
  /maxout margin 4096
  /maxout limit 131072
MSG
