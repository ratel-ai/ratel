import { parseConfig, type RatelConfig, type ServerEntry } from "@ratel-ai/mcp-server";
import { type BackupManifest, startBackup } from "../backup.js";
import { type RatelScope, ratelConfigPath, resolveScope } from "../hierarchy.js";
import { readJson, writeJson } from "../io.js";
import { type AuthProbeResult, authProbeEntry, probeEntryInstructions } from "../probe.js";
import type { HandlerCtx } from "./types.js";

const OAUTH_FLAGS = ["client-id", "client-secret", "callback-port", "oauth-scope"] as const;

export type ProbeFn = (name: string, entry: ServerEntry) => Promise<string | undefined>;
export type AuthProbeFn = (name: string, entry: ServerEntry) => Promise<AuthProbeResult>;

export interface RunAddOptions {
  probe?: ProbeFn;
  authProbe?: AuthProbeFn;
}

export async function runAdd(ctx: HandlerCtx, opts: RunAddOptions = {}): Promise<BackupManifest> {
  const scope = readScope(ctx);
  const name = readName(ctx);
  const entry = assembleEntry(ctx);

  applyOAuthFlags(ctx, entry);

  parseConfig({ mcpServers: { [name]: entry } });

  await maybeProbeAndAuth(ctx, name, entry, opts);

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
  logEntryRecap(ctx, scope, name, entry);
  return manifest;
}

const PREVIEW_MAX = 120;

function previewDescription(s: string): string {
  const newlineIdx = s.indexOf("\n");
  const cut = newlineIdx >= 0 ? Math.min(newlineIdx, PREVIEW_MAX) : PREVIEW_MAX;
  if (cut < s.length) return `${s.slice(0, cut)}…`;
  return s;
}

function logEntryRecap(ctx: HandlerCtx, scope: RatelScope, name: string, entry: ServerEntry): void {
  const type = entry.type ?? "stdio";
  ctx.log(`  type:          ${type}`);
  if (type === "stdio") {
    if (entry.command) {
      const cmd =
        entry.args && entry.args.length > 0
          ? `${entry.command} ${entry.args.join(" ")}`
          : entry.command;
      ctx.log(`  command:       ${cmd}`);
    }
    if (entry.env && Object.keys(entry.env).length > 0) {
      ctx.log(`  env:           ${Object.keys(entry.env).join(", ")}`);
    }
    if (entry.cwd) ctx.log(`  cwd:           ${entry.cwd}`);
  } else {
    if (entry.url) ctx.log(`  url:           ${entry.url}`);
    if (entry.headers && Object.keys(entry.headers).length > 0) {
      ctx.log(`  headers:       ${Object.keys(entry.headers).join(", ")}`);
    }
    if (entry.clientId) ctx.log(`  client-id:     ${entry.clientId}`);
    if (entry.clientSecret) ctx.log(`  client-secret: (hidden)`);
    if (entry.callbackPort !== undefined) {
      ctx.log(`  callback-port: ${entry.callbackPort}`);
    }
    if (entry.scope) ctx.log(`  oauth-scope:   ${entry.scope}`);
  }
  if (entry.description) {
    ctx.log(`  description:   ${previewDescription(entry.description)}`);
  }
  ctx.log(`something not right? \`ratel mcp edit --scope ${scope} --name ${name}\``);
}

function readScope(ctx: HandlerCtx): RatelScope {
  return resolveScope(ctx.argv.flags.scope);
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

async function maybeProbeAndAuth(
  ctx: HandlerCtx,
  name: string,
  entry: ServerEntry,
  opts: RunAddOptions,
): Promise<void> {
  if (ctx.argv.flags["fetch-description"] === false) return;

  if (entry.type === "http" || entry.type === "sse") {
    const authProbe = opts.authProbe ?? ((n, e) => authProbeEntry(n, e, { logger: ctx.log }));
    let result: AuthProbeResult;
    try {
      result = await authProbe(name, entry);
    } catch (err) {
      ctx.log(
        `[ratel] could not authorize ${name}: ${(err as Error).message}; run \`ratel mcp auth ${name}\` to retry`,
      );
      return;
    }
    if (result.status !== "authorized") {
      const reason = result.reason ?? "unknown reason";
      ctx.log(
        `[ratel] could not authorize ${name}: ${reason}; run \`ratel mcp auth ${name}\` to retry`,
      );
      return;
    }
    if (!entry.description && result.instructions && result.instructions.length > 0) {
      entry.description = result.instructions;
      ctx.log(`[ratel] fetched description from ${name}'s upstream instructions`);
    }
    return;
  }

  if (entry.description) return;
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

function applyOAuthFlags(ctx: HandlerCtx, entry: ServerEntry): void {
  const present = OAUTH_FLAGS.filter((k) => ctx.argv.flags[k] !== undefined);
  if (present.length === 0) return;
  if (entry.type !== "http" && entry.type !== "sse") {
    throw new Error(
      `--${present.join(", --")} only apply to http/sse entries; received type="${entry.type}"`,
    );
  }
  const clientId = ctx.argv.flags["client-id"];
  if (typeof clientId === "string" && clientId.length > 0) entry.clientId = clientId;
  const clientSecret = ctx.argv.flags["client-secret"];
  if (typeof clientSecret === "string" && clientSecret.length > 0) {
    entry.clientSecret = clientSecret;
    ctx.log(
      "[ratel] warning: --client-secret is stored as plaintext in the config file; prefer PKCE (no client secret) when the upstream supports it",
    );
  }
  const callbackPort = ctx.argv.flags["callback-port"];
  if (callbackPort !== undefined) {
    const n = typeof callbackPort === "number" ? callbackPort : Number(callbackPort);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new Error(`--callback-port must be an integer in [0, 65535], got "${callbackPort}"`);
    }
    entry.callbackPort = n;
  }
  const scope = ctx.argv.flags["oauth-scope"];
  if (typeof scope === "string" && scope.length > 0) entry.scope = scope;
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}
