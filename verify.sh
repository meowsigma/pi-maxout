#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
(
  cd "$SRC_DIR"
  npm test
  npm run typecheck
)
bash -n "$SRC_DIR/install.sh" "$SRC_DIR/uninstall.sh" "$SRC_DIR/verify.sh"
for required in index.ts core.mjs core.d.mts auto.mjs auto.d.mts adaptive.mjs adaptive.d.mts README.md; do
  test -f "$SRC_DIR/$required" || {
    echo "ERROR: missing install artifact: $required" >&2
    exit 1
  }
done
echo "pi-maxout verification passed."
