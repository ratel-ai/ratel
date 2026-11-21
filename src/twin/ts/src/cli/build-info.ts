import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "../manifest.js";

/**
 * What the worker loaded: the git SHA and dirty flag of the project at root
 * (when it is a git checkout) and a revision of the twin files' content. The
 * revision changes with any edit of a twin file, also without git or in a
 * checkout that is already dirty.
 */
export function buildInfo(root: string, files: readonly string[]): Manifest["build"] {
  return { ...gitInfo(root), revision: twinRevision(root, files) };
}

/** Lowercase hex SHA-256 over the sorted twin file paths and their bytes. */
export function twinRevision(root: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    hash.update(file).update("\0");
    try {
      hash.update(readFileSync(join(root, file)));
    } catch {
      hash.update("<unreadable>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function gitInfo(root: string): { id?: string; dirty?: boolean } {
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    return { id: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
  } catch {
    return {};
  }
}
