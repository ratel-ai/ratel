import { join } from "node:path";
import type { RatelConfig, ServerEntry } from "@ratel-ai/mcp-server";
import { ProjectRootNotFoundError, type RatelScope, ratelConfigPath } from "../hierarchy.js";
import { readJson } from "../io.js";
import type { HandlerCtx } from "./types.js";

const SCOPES: readonly RatelScope[] = ["user", "project", "local"];

type AuthStatus = "n/a" | "needs auth" | "expired" | "ok";

interface StoredOAuth {
  tokens?: { access_token?: string };
  expires_at?: number;
}

export async function runMcpList(ctx: HandlerCtx): Promise<void> {
  let totalEntries = 0;
  const sections: string[] = [];

  for (const scope of SCOPES) {
    let path: string;
    try {
      path = ratelConfigPath(scope, ctx.env);
    } catch (err) {
      if (err instanceof ProjectRootNotFoundError) continue;
      throw err;
    }
    const cfg = await readJson<RatelConfig>(ctx.fs, path);
    if (!cfg) continue;
    const entries = Object.entries(cfg.mcpServers);
    if (entries.length === 0) continue;

    totalEntries += entries.length;
    const lines = [`${scope}:  (${path})`];
    for (const [name, entry] of entries) {
      const status = await resolveAuthStatus(ctx, name, entry);
      lines.push(`  ${name.padEnd(20)} [${status}]  ${formatEntry(entry)}`);
    }
    sections.push(lines.join("\n"));
  }

  if (totalEntries === 0) {
    ctx.log("no MCP servers configured in any Ratel scope");
    return;
  }
  ctx.log(sections.join("\n\n"));
}

function formatEntry(entry: ServerEntry): string {
  const type = entry.type ?? "stdio";
  if (type === "stdio") {
    const args = entry.args && entry.args.length > 0 ? ` ${entry.args.join(" ")}` : "";
    return `[${type}] ${entry.command ?? "<no command>"}${args}`;
  }
  return `[${type}] ${entry.url ?? "<no url>"}`;
}

async function resolveAuthStatus(
  ctx: HandlerCtx,
  name: string,
  entry: ServerEntry,
): Promise<AuthStatus> {
  if (entry.type !== "http" && entry.type !== "sse") return "n/a";
  if (!ctx.env.homeDir) return "needs auth";
  const path = join(ctx.env.homeDir, ".ratel", "oauth", `${name}.json`);
  const stored = await readJson<StoredOAuth>(ctx.fs, path);
  if (!stored?.tokens?.access_token) return "needs auth";
  if (typeof stored.expires_at === "number" && stored.expires_at < Date.now()) {
    return "expired";
  }
  return "ok";
}
