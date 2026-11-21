import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadTwins, messageOf } from "../cli/load.js";
import { buildManifest } from "../manifest.js";
import type { ChildReply, ChildRequest } from "./child-messages.js";

// The long-lived child of `ratel dev`. It is the only process that loads user
// code and the project's .env. The parent restarts it on a file change, so each
// generation imports the code fresh. It lives until the parent disconnects.

let envLoaded = false;

process.on("message", (request: ChildRequest) => {
  handle(request)
    .catch((err: unknown): ChildReply => ({ id: request.id, ok: false, error: messageOf(err) }))
    .then((reply) => process.send?.(reply));
});
process.on("disconnect", () => process.exit(0));

async function handle(request: ChildRequest): Promise<ChildReply> {
  loadEnvOnce(request.root);
  const twins = await loadTwins(request.root, request.files);
  return {
    id: request.id,
    ok: true,
    kind: "manifest",
    manifest: buildManifest({ twins, build: request.build, env: process.env }),
  };
}

function loadEnvOnce(root: string): void {
  if (envLoaded) return;
  envLoaded = true;
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}
