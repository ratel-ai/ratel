import { type BackupManifest, startBackup } from "../backup.js";
import type { RatelConfig } from "../config.js";
import { type RatelScope, ratelConfigPath } from "../hierarchy.js";
import { readJson, writeJson } from "../io.js";
import type { HandlerCtx } from "./types.js";

export async function runRemove(ctx: HandlerCtx): Promise<BackupManifest> {
  const scope = readScope(ctx);
  const name = readRequiredString(ctx, "name");
  const path = ratelConfigPath(scope, ctx.env);
  const current = await readJson<RatelConfig>(ctx.fs, path);
  if (!current?.mcpServers[name]) {
    throw new Error(`entry "${name}" not found at scope ${scope}`);
  }

  const session = startBackup(ctx.env, ctx.fs);
  await session.capture(path);
  const manifest = await session.finalize("remove");

  delete current.mcpServers[name];
  await writeJson(ctx.fs, path, current);
  ctx.log(`removed "${name}" from ${path}`);
  return manifest;
}

function readScope(ctx: HandlerCtx): RatelScope {
  const v = readRequiredString(ctx, "scope");
  if (v !== "global" && v !== "project" && v !== "local") {
    throw new Error(`--scope must be one of global|project|local, got "${v}"`);
  }
  return v;
}

function readRequiredString(ctx: HandlerCtx, key: string): string {
  const v = ctx.argv.flags[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return v;
}
