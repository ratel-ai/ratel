import { join } from "node:path";
import {
  type AuthFlowOptions,
  type AuthFlowResult,
  buildGatewayFromConfig,
  mergeConfigs,
  type RatelConfig,
  type ServerEntry,
} from "@ratel-ai/mcp-server";
import { ProjectRootNotFoundError, type RatelScope, ratelConfigPath } from "../hierarchy.js";
import { readJson } from "../io.js";
import type { HandlerCtx } from "./types.js";

const SCOPES: readonly RatelScope[] = ["user", "project", "local"];

export type AuthRunner = (opts: AuthFlowOptions) => Promise<AuthFlowResult[]>;

export interface RunMcpAuthOptions {
  /** Override the orchestrator. Tests stub this to avoid spinning up a live gateway. */
  authRunner?: AuthRunner;
}

export async function runMcpAuth(ctx: HandlerCtx, opts: RunMcpAuthOptions = {}): Promise<void> {
  const config = await loadMergedConfig(ctx);
  if (!config || Object.keys(config.mcpServers).length === 0) {
    ctx.log("[ratel] no Ratel config found in user/project/local scope; nothing to auth");
    return;
  }

  if (ctx.argv.flags.check === true) {
    await printCheckReport(ctx, config);
    return;
  }

  const positional = ctx.argv.rest[0];
  const authOpts: AuthFlowOptions = {};
  if (positional) {
    if (!config.mcpServers[positional]) {
      throw new Error(`unknown upstream "${positional}" — not present in any Ratel scope`);
    }
    authOpts.name = positional;
  }

  const runner = opts.authRunner ?? (await defaultAuthRunner(config, ctx));
  const results = await runner(authOpts);
  printResults(ctx, results);
}

async function loadMergedConfig(ctx: HandlerCtx): Promise<RatelConfig | undefined> {
  const parts: RatelConfig[] = [];
  for (const scope of SCOPES) {
    let path: string;
    try {
      path = ratelConfigPath(scope, ctx.env);
    } catch (err) {
      if (err instanceof ProjectRootNotFoundError) continue;
      throw err;
    }
    const cfg = await readJson<RatelConfig>(ctx.fs, path);
    if (cfg) parts.push(cfg);
  }
  if (parts.length === 0) return undefined;
  return mergeConfigs(parts);
}

async function defaultAuthRunner(config: RatelConfig, ctx: HandlerCtx): Promise<AuthRunner> {
  const gateway = await buildGatewayFromConfig(config, { logger: ctx.log });
  return async (opts) => {
    try {
      return await gateway.runAuthFlow(opts);
    } finally {
      await gateway.close();
    }
  };
}

function printResults(ctx: HandlerCtx, results: AuthFlowResult[]): void {
  if (results.length === 0) {
    ctx.log("[ratel] no upstreams to authorize");
    return;
  }
  for (const r of results) {
    const annotation =
      r.status === "authorized" && r.mode
        ? ` (${r.mode === "refresh" ? "refreshed" : "re-authed"})`
        : "";
    const tail = r.reason ? `: ${r.reason}` : "";
    ctx.log(`  ${r.name.padEnd(20)} ${r.status}${annotation}${tail}`);
  }
}

interface StoredOAuth {
  tokens?: { access_token?: string; refresh_token?: string };
  expires_at?: number;
}

type CheckStatus = "n/a" | "needs auth" | "expired" | "ok";

async function printCheckReport(ctx: HandlerCtx, config: RatelConfig): Promise<void> {
  const lines: string[] = [];
  for (const [name, entry] of Object.entries(config.mcpServers)) {
    const { status, detail } = await checkUpstream(ctx, name, entry);
    const detailText = detail ? `  ${detail}` : "";
    lines.push(`  ${name.padEnd(20)} [${status}]${detailText}`);
  }
  ctx.log(lines.join("\n"));
}

async function checkUpstream(
  ctx: HandlerCtx,
  name: string,
  entry: ServerEntry,
): Promise<{ status: CheckStatus; detail?: string }> {
  if (entry.type !== "http" && entry.type !== "sse") return { status: "n/a" };
  if (!ctx.env.homeDir) return { status: "needs auth" };
  const path = join(ctx.env.homeDir, ".ratel", "oauth", `${name}.json`);
  const stored = await readJson<StoredOAuth>(ctx.fs, path);
  if (!stored?.tokens?.access_token) {
    return { status: "needs auth", detail: "no tokens stored" };
  }
  const expiresAt = typeof stored.expires_at === "number" ? stored.expires_at : undefined;
  const refreshAvailable = typeof stored.tokens.refresh_token === "string";
  const now = Date.now();
  if (expiresAt !== undefined && expiresAt < now) {
    const ago = humanizeDuration(now - expiresAt);
    const refreshNote = refreshAvailable ? ", refresh available" : ", no refresh token";
    return { status: "expired", detail: `expired ${ago} ago${refreshNote}` };
  }
  if (expiresAt !== undefined) {
    return { status: "ok", detail: `expires in ${humanizeDuration(expiresAt - now)}` };
  }
  return { status: "ok" };
}

function humanizeDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}
