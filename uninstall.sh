#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
DEST="$AGENT_DIR/extensions/pi-maxout"
STATE="$AGENT_DIR/pi-maxout.json"

if [[ -d "$DEST" ]]; then
  rm -rf "$DEST"
  echo "Removed: $DEST"
else
  echo "pi-maxout is not installed at: $DEST"
fi

if [[ "${1:-}" == "--purge" ]]; then
  rm -f "$STATE"
  echo "Removed saved defaults: $STATE"
else
  cat <<MSG
Saved per-model defaults were left untouched:
  $STATE
Run this script with --purge only if you also want to erase those defaults.
MSG
fi
