import { parseConfig, type RatelConfig, type ServerEntry } from "@ratel-ai/mcp-server";
import { type BackupManifest, startBackup } from "../backup.js";
import { type RatelScope, ratelConfigPath } from "../hierarchy.js";
import { readJson, writeJson } from "../io.js";
import { probeEntryInstructions } from "../probe.js";
import type { HandlerCtx } from "./types.js";

const OAUTH_FLAGS = ["client-id", "client-secret", "callback-port"] as const;

export type ProbeFn = (name: string, entry: ServerEntry) => Promise<string | undefined>;

export interface RunAddOptions {
  probe?: ProbeFn;
}

export async function runAdd(ctx: HandlerCtx, opts: RunAddOptions = {}): Promise<BackupManifest> {
  const scope = readScope(ctx);
  const name = readName(ctx);
  const entry = assembleEntry(ctx);

  parseConfig({ mcpServers: { [name]: entry } });

  warnAboutOAuthFlags(ctx);

  await maybeFetchDescription(ctx, name, entry, opts);

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
  const v = ctx.argv.flags.scope;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error("--scope is required (one of user|project|local)");
  }
  if (v === "global") {
    throw new Error('--scope value "global" is no longer supported; use "user" instead');
  }
  if (v !== "user" && v !== "project" && v !== "local") {
    throw new Error(`--scope must be one of user|project|local, got "${v}"`);
  }
  return v;
}

function readName(ctx: HandlerCtx): string {
  const positional = ctx.argv.rest[0];
  if (positional && !looksLikeUrl(positional)) {
    return positional;
  }
  if (positional) {
    // first positional is a URL; we expect <name> first
    throw new Error("first positional must be a name; received what looks like a URL");
  }
  throw new Error("name is required: ratel mcp add [flags] <name> [-- <command> ...] | <url>");
}

function assembleEntry(ctx: HandlerCtx): ServerEntry {
  const transportFlag = ctx.argv.flags.transport;
  const explicitTransport = typeof transportFlag === "string" ? transportFlag : undefined;
  const second = ctx.argv.rest[1];
  const extras = ctx.argv.extras;

  let entry: ServerEntry;
  if (extras.length > 0) {
    if (explicitTransport && explicitTransport !== "stdio") {
      throw new Error(
        `--transport ${explicitTransport} is incompatible with a "-- <command>" form; use a URL positional instead`,
      );
    }
    const [command, ...args] = extras;
    entry = { type: "stdio", command };
    if (args.length > 0) entry.args = args;
    const env = parseEnv(ctx);
    if (env) entry.env = env;
  } else if (second) {
    const transport = explicitTransport ?? "http";
    if (transport !== "http" && transport !== "sse") {
      throw new Error(
        `--transport ${transport} requires a "-- <command>" form, not a URL positional`,
      );
    }
    entry = { type: transport, url: second };
    const headers = parseHeaders(ctx);
    if (headers) entry.headers = headers;
  } else {
    throw new Error("expected either `-- <command> [args...]` for stdio or `<url>` for http/sse");
  }

  const description = ctx.argv.flags.description;
  if (typeof description === "string" && description.length > 0) {
    entry.description = description;
  }
  return entry;
}

function parseEnv(ctx: HandlerCtx): Record<string, string> | undefined {
  const raw = ctx.argv.flags.env;
  if (raw === undefined || raw === false) return undefined;
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  if (list.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const pair of list) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--env must be KEY=VALUE, got "${pair}"`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function parseHeaders(ctx: HandlerCtx): Record<string, string> | undefined {
  const raw = ctx.argv.flags.header;
  if (raw === undefined || raw === false) return undefined;
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  if (list.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const pair of list) {
    const colon = pair.indexOf(":");
    if (colon <= 0) {
      throw new Error(`--header must be in "Name: Value" form, got "${pair}"`);
    }
    const key = pair.slice(0, colon).trim();
    const val = pair.slice(colon + 1).trim();
    if (!key) {
      throw new Error(`--header must be in "Name: Value" form, got "${pair}"`);
    }
    out[key] = val;
  }
  return out;
}

async function maybeFetchDescription(
  ctx: HandlerCtx,
  name: string,
  entry: ServerEntry,
  opts: RunAddOptions,
): Promise<void> {
  if (entry.description) return;
  if (ctx.argv.flags["fetch-description"] === false) return;
  const probe = opts.probe ?? ((n, e) => probeEntryInstructions(n, e));
  let fetched: string | undefined;
  try {
    fetched = await probe(name, entry);
  } catch {
    return;
  }
  if (fetched && fetched.length > 0) {
    entry.description = fetched;
    ctx.log(`[ratel] fetched description from ${name}'s upstream instructions`);
  }
}

function warnAboutOAuthFlags(ctx: HandlerCtx): void {
  const present = OAUTH_FLAGS.filter((k) => ctx.argv.flags[k] !== undefined);
  if (present.length === 0) return;
  ctx.log(
    `[ratel] note: --${present.join(", --")} captured but not yet wired into auth flow (deferred to v0.1.4)`,
  );
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}
