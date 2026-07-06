import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { UNIT_IDS } from "./release-units.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);

// Regression: the CLI must run even when the module is invoked through a symlinked
// path. ESM resolves symlinks in import.meta.url but process.argv[1] does not, so a
// plain string compare in the `is this the entry script?` guard silently skips
// main() when the repo is reached via a symlink — `--list` then prints nothing, and
// publish-rc.sh reports `unknown unit '…' (valid: )`. This spawns the script through
// a symlink and asserts the CLI actually produced its unit list.
test("release-units.mjs --list runs through a symlinked path", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "ratel-symlink-"));
  const link = join(tmp, "repo");
  try {
    symlinkSync(repoRoot, link, "dir");
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    t.skip(`cannot create symlink in this environment: ${e.message}`);
    return;
  }
  try {
    const out = execFileSync("node", [join(link, "scripts", "release-units.mjs"), "--list"], {
      encoding: "utf8",
    });
    const units = out.trim().split("\n").filter(Boolean);
    assert.deepEqual(units, UNIT_IDS, `--list through a symlink returned ${JSON.stringify(out)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
