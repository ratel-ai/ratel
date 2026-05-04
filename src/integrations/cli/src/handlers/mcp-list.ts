import type { RatelConfig, ServerEntry } from "@ratel-ai/mcp-server";
import { ProjectRootNotFoundError, type RatelScope, ratelConfigPath } from "../hierarchy.js";
import { readJson } from "../io.js";
import type { HandlerCtx } from "./types.js";

const SCOPES: readonly RatelScope[] = ["user", "project", "local"];

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
      lines.push(`  ${name.padEnd(20)} ${formatEntry(entry)}`);
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
