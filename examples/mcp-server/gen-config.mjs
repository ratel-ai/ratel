import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(start) {
  let dir = start;
  while (dir !== "/") {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate repo root (no pnpm-workspace.yaml found above this folder)");
}

const repoRoot = findRepoRoot(here);
const template = readFileSync(resolve(here, "claude-with-ratel.template.json"), "utf8");
const resolved = template.replaceAll("<REPO_ROOT>", repoRoot);
writeFileSync(resolve(here, "claude-with-ratel.json"), resolved);
console.error(`wrote claude-with-ratel.json (REPO_ROOT=${repoRoot})`);
