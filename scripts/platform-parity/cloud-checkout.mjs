// The Ratel Cloud checkout the parity capture reads (temporary parity harness, RTL-45).
// The captured files are "Cloud at the synced commit", so a checkout at any other commit is
// refused: nothing else may be written under that name.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** The checkout's root, or an Error saying why it cannot be captured from. */
export function cloudCheckout(cloudDir, expectedCommit) {
  if (!cloudDir) throw new Error("RATEL_CLOUD_DIR is not set: point it at a ratel-cloud git checkout.");
  const root = resolve(cloudDir);
  if (!existsSync(join(root, "apps", "web", "package.json"))) {
    throw new Error(`${root} is not a ratel-cloud checkout (no apps/web).`);
  }
  let head;
  try {
    head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error(`${root} is not a git checkout.`);
  }
  if (head !== expectedCommit) {
    throw new Error(
      `${root} is at ${head.slice(0, 8)}, not at ${expectedCommit.slice(0, 8)} (scripts/platform-sync/source.json). Check that commit out, or sync first.`,
    );
  }
  return root;
}
