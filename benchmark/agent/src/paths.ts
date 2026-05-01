// Resolve relative paths against the repo root, not the current cwd. pnpm runs
// workspace scripts with `cwd = <package dir>`, so a default path like
// `benchmark/test-data/synthetic.jsonl` would otherwise resolve under
// `benchmark/agent/benchmark/...`. Anchoring to the root makes the CLI behave
// the same whether invoked from the repo root or from the package directory.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(start: string): string {
  let cur = start;
  for (let depth = 0; depth < 16; depth++) {
    if (existsSync(resolve(cur, "pnpm-workspace.yaml"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error(`could not find repo root walking up from ${start}`);
}

export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

/** Resolve a path: absolute paths are returned as-is; relative paths anchor to the repo root. */
export function resolveRepoPath(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}
