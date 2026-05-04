import type { RatelConfig, ServerEntry } from "@ratel-ai/mcp-server";
import { ProjectRootNotFoundError, type RatelScope, ratelConfigPath } from "../hierarchy.js";
import { readJson } from "../io.js";
import type { HandlerCtx } from "./types.js";

const SCOPES: readonly RatelScope[] = ["local", "project", "user"];

export async function runMcpGet(ctx: HandlerCtx): Promise<void> {
  const name = ctx.argv.rest[0];
  if (!name) {
    throw new Error("name is required: ratel mcp get <name> [--scope <s>]");
  }
  const scopeFlag = ctx.argv.flags.scope;
  if (scopeFlag === "global") {
    throw new Error('--scope value "global" is no longer supported; use "user" instead');
  }
  if (typeof scopeFlag === "string") {
    if (scopeFlag !== "user" && scopeFlag !== "project" && scopeFlag !== "local") {
      throw new Error(`--scope must be one of user|project|local, got "${scopeFlag}"`);
    }
    const found = await readScope(ctx, scopeFlag);
    const entry = found?.cfg.mcpServers[name];
    if (!entry) {
      throw new Error(`entry "${name}" not found in scope ${scopeFlag}`);
    }
    printResolved(ctx, name, scopeFlag, found?.path ?? "", entry);
    return;
  }

  for (const scope of SCOPES) {
    const found = await readScope(ctx, scope);
    if (!found) continue;
    const entry = found.cfg.mcpServers[name];
    if (entry) {
      printResolved(ctx, name, scope, found.path, entry);
      return;
    }
  }
  throw new Error(`entry "${name}" not found in any Ratel scope`);
}

async function readScope(
  ctx: HandlerCtx,
  scope: RatelScope,
): Promise<{ path: string; cfg: RatelConfig } | null> {
  let path: string;
  try {
    path = ratelConfigPath(scope, ctx.env);
  } catch (err) {
    if (err instanceof ProjectRootNotFoundError) return null;
    throw err;
  }
  const cfg = await readJson<RatelConfig>(ctx.fs, path);
  return cfg ? { path, cfg } : null;
}

function printResolved(
  ctx: HandlerCtx,
  name: string,
  scope: RatelScope,
  path: string,
  entry: ServerEntry,
): void {
  ctx.log(`${name}  [${scope}]  (${path})`);
  ctx.log(JSON.stringify(entry, null, 2));
}
