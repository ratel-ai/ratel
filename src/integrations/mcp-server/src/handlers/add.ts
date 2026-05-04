import { type BackupManifest, startBackup } from "../backup.js";
import { parseConfig, type RatelConfig, type ServerEntry } from "../config.js";
import { type RatelScope, ratelConfigPath } from "../hierarchy.js";
import { readJson, writeJson } from "../io.js";
import type { HandlerCtx } from "./types.js";

export async function runAdd(ctx: HandlerCtx): Promise<BackupManifest> {
  const scope = readScope(ctx);
  const name = readRequiredString(ctx, "name");
  const entry = assembleEntry(ctx);

  parseConfig({ mcpServers: { [name]: entry } });

  const path = ratelConfigPath(scope, ctx.env);
  const current = (await readJson<RatelConfig>(ctx.fs, path)) ?? { mcpServers: {} };
  const force = ctx.argv.flags.force === true;
  if (current.mcpServers[name] && !force) {
    throw new Error(`entry "${name}" already exists at scope ${scope}; pass --force to overwrite`);
  }

  const session = startBackup(ctx.env, ctx.fs);
  await session.capture(path);
  const manifest = await session.finalize("add");

  current.mcpServers[name] = entry;
  await writeJson(ctx.fs, path, current);
  ctx.log(`added "${name}" to ${path}`);
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

function assembleEntry(ctx: HandlerCtx): ServerEntry {
  const entryJson = ctx.argv.flags["entry-json"];
  let entry: ServerEntry;
  if (typeof entryJson === "string") {
    entry = JSON.parse(entryJson) as ServerEntry;
  } else {
    const command = ctx.argv.flags.command;
    if (typeof command !== "string") {
      throw new Error("--command or --entry-json is required");
    }
    entry = { type: "stdio", command };
  }
  const description = ctx.argv.flags.description;
  if (typeof description === "string" && description.length > 0) {
    entry.description = description;
  }
  return entry;
}
