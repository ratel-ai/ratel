import { execFileSync } from "node:child_process";
import type { Manifest } from "../manifest.js";

/** The git SHA and dirty flag of the project at root, or undefined outside a git checkout. */
export function buildInfo(root: string): Manifest["build"] {
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    return { id: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
  } catch {
    return undefined;
  }
}
