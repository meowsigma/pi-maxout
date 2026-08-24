import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("installer stores backups outside the extension discovery directory", () => {
  const script = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  assert.match(script, /STAGE="\$AGENT_DIR\/\.pi-maxout-stage-\$\$"/);
  assert.doesNotMatch(script, /STAGE="\$EXTENSIONS_DIR\//);
  assert.match(script, /BACKUPS_DIR="\$AGENT_DIR\/backups\/pi-maxout"/);
  assert.match(script, /BACKUP="\$BACKUPS_DIR\/pi-maxout-/);
  assert.doesNotMatch(script, /BACKUP="\$\{DEST\}\.backup-/);
});
