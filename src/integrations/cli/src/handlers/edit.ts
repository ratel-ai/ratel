import { parseConfig, type RatelConfig, type ServerEntry } from "@ratel-ai/mcp-server";
import { type BackupManifest, startBackup } from "../backup.js";
import { type RatelScope, ratelConfigPath } from "../hierarchy.js";
import { readJson, writeJson } from "../io.js";
import type { PromptAdapter } from "../prompts.js";
import type { HandlerCtx } from "./types.js";

const FIELD_FLAGS = [
  "description",
  "type",
  "command",
  "arg",
  "env",
  "cwd",
  "url",
  "header",
] as const;

type FieldFlag = (typeof FIELD_FLAGS)[number];

const INTERACTIVE_FIELDS: { value: FieldFlag | "done"; label: string }[] = [
  { value: "description", label: "description" },
  { value: "type", label: "type (stdio|http|sse)" },
  { value: "command", label: "command (stdio)" },
  { value: "url", label: "url (http/sse)" },
  { value: "cwd", label: "cwd (stdio)" },
  { value: "done", label: "(done — write changes)" },
];

export async function runEdit(ctx: HandlerCtx): Promise<BackupManifest> {
  const scope = readScope(ctx);
  const name = readRequiredString(ctx, "name");
  const path = ratelConfigPath(scope, ctx.env);
  const current = await readJson<RatelConfig>(ctx.fs, path);
  if (!current?.mcpServers[name]) {
    throw new Error(`entry "${name}" not found at scope ${scope}`);
  }

  const updated = await assembleUpdatedEntry(ctx, current.mcpServers[name]);
  parseConfig({ mcpServers: { [name]: updated } });

  const session = startBackup(ctx.env, ctx.fs);
  await session.capture(path);
  const manifest = await session.finalize("edit");

  current.mcpServers[name] = updated;
  await writeJson(ctx.fs, path, current);
  ctx.log(`updated "${name}" at ${path}`);
  return manifest;
}

async function assembleUpdatedEntry(ctx: HandlerCtx, existing: ServerEntry): Promise<ServerEntry> {
  const flags = ctx.argv.flags;
  const entryJson = flags["entry-json"];
  if (typeof entryJson === "string") {
    if (FIELD_FLAGS.some((f) => flags[f] !== undefined)) {
      throw new Error("--entry-json is mutually exclusive with field flags");
    }
    return JSON.parse(entryJson) as ServerEntry;
  }

  const hasFieldFlag = FIELD_FLAGS.some((f) => flags[f] !== undefined);
  if (!hasFieldFlag) {
    return interactiveEdit(ctx.prompts, existing);
  }

  return applyFieldFlags(existing, flags);
}

function applyFieldFlags(existing: ServerEntry, flags: Record<string, unknown>): ServerEntry {
  const next: ServerEntry = { ...existing };

  if (flags.description !== undefined) {
    setOrDelete(next, "description", asString(flags.description, "description"));
  }
  if (flags.type !== undefined) {
    next.type = asString(flags.type, "type") || "stdio";
  }
  if (flags.command !== undefined) {
    next.command = asString(flags.command, "command");
  }
  if (flags.cwd !== undefined) {
    setOrDelete(next, "cwd", asString(flags.cwd, "cwd"));
  }
  if (flags.url !== undefined) {
    next.url = asString(flags.url, "url");
  }
  if (flags.arg !== undefined) {
    next.args = asStringArray(flags.arg);
  }
  if (flags.env !== undefined) {
    next.env = mergeKeyVals(next.env, asStringArray(flags.env));
  }
  if (flags.header !== undefined) {
    next.headers = mergeKeyVals(next.headers, asStringArray(flags.header));
  }
  return next;
}

function setOrDelete(entry: ServerEntry, key: "description" | "cwd", value: string): void {
  if (value.length === 0) {
    delete entry[key];
  } else {
    entry[key] = value;
  }
}

function asString(v: unknown, key: string): string {
  if (typeof v === "boolean") {
    throw new Error(`--${key} requires a value`);
  }
  if (Array.isArray(v)) {
    throw new Error(`--${key} cannot be repeated`);
  }
  return v as string;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return [v];
  return [];
}

function mergeKeyVals(
  existing: Record<string, string> | undefined,
  pairs: string[],
): Record<string, string> | undefined {
  const next: Record<string, string> = { ...(existing ?? {}) };
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) {
      throw new Error(`expected KEY=VALUE, got "${pair}"`);
    }
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (value.length === 0) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  if (Object.keys(next).length === 0) return undefined;
  return next;
}

async function interactiveEdit(
  prompts: PromptAdapter,
  existing: ServerEntry,
): Promise<ServerEntry> {
  const next: ServerEntry = { ...existing };
  while (true) {
    const field = await prompts.select({
      message: "Pick a field to edit",
      options: INTERACTIVE_FIELDS,
    });
    if (prompts.isCancel(field)) {
      throw new Error("edit cancelled");
    }
    if (field === "done") return next;

    const key = field as Exclude<FieldFlag, "arg" | "env" | "header">;
    const initial = stringField(next, key) ?? "";
    const v = await prompts.text({
      message: `New value for ${key}`,
      initialValue: initial,
    });
    if (prompts.isCancel(v)) {
      throw new Error("edit cancelled");
    }
    const value = v as string;
    if (key === "description" || key === "cwd") {
      setOrDelete(next, key, value);
    } else if (key === "type") {
      next.type = value || "stdio";
    } else if (key === "command") {
      next.command = value;
    } else if (key === "url") {
      next.url = value;
    }
  }
}

function stringField(entry: ServerEntry, key: FieldFlag): string | undefined {
  const v = (entry as unknown as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function readScope(ctx: HandlerCtx): RatelScope {
  const v = readRequiredString(ctx, "scope");
  if (v !== "user" && v !== "project" && v !== "local") {
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
