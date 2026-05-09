import { ArgError } from "../args.js";
import { runAdd } from "./add.js";
import { runEdit } from "./edit.js";
import { runMcpGet } from "./get.js";
import { runImport } from "./import.js";
import { runLink } from "./link.js";
import { runMcpAuth } from "./mcp-auth.js";
import { runMcpList } from "./mcp-list.js";
import { runRemove } from "./remove.js";
import type { HandlerCtx } from "./types.js";

export const MCP_USAGE = `usage: ratel mcp <verb> [args...]

Verbs:
  add     add an MCP server entry (Claude-compatible: ratel mcp add [flags] <name> -- <command> [args...]
                                   or ratel mcp add [flags] <name> <url>)
  remove  remove an entry from a Ratel scope
  list    list MCP servers configured across Ratel scopes
  get     show one entry's resolved details
  edit    edit fields on an existing entry (interactive when no flags supplied)
  import  migrate Claude Code MCP configs into Ratel (two stages: Ratel write, then Claude rewrite)
  link    rewrite Claude Code's config to point at Ratel for entries already in Ratel scopes
  auth    drive an interactive OAuth flow for one or all http/sse upstreams that need authorization

To start the gateway, see \`ratel serve\`.`;

export async function runMcp(ctx: HandlerCtx): Promise<void> {
  const { verb, flags } = ctx.argv;
  switch (verb) {
    case "add":
      await runAdd(ctx);
      return;
    case "remove":
      await runRemove(ctx);
      return;
    case "list":
      await runMcpList(ctx);
      return;
    case "get":
      await runMcpGet(ctx);
      return;
    case "edit":
      await runEdit(ctx);
      return;
    case "import":
      await runImport(ctx, {
        yes: flags.yes === true,
        dryRun: flags["dry-run"] === true,
      });
      return;
    case "link":
      await runLink(ctx, { yes: flags.yes === true });
      return;
    case "auth":
      await runMcpAuth(ctx);
      return;
    default:
      throw new ArgError(`unknown mcp verb: ${verb}`);
  }
}
