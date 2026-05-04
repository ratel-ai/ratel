import {
  type AuthFlowOptions,
  type AuthFlowResult,
  buildGatewayFromConfig,
  mergeConfigs,
  type RatelConfig,
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
    const tail = r.reason ? `: ${r.reason}` : "";
    ctx.log(`  ${r.name.padEnd(20)} ${r.status}${tail}`);
  }
}
