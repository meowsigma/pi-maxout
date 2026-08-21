#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node --test "$SRC_DIR/tests/core.test.mjs"
bash -n "$SRC_DIR/install.sh" "$SRC_DIR/uninstall.sh" "$SRC_DIR/verify.sh"
echo "pi-maxout verification passed."
