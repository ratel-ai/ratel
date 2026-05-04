import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  buildGatewayFromConfig,
  createMcpServer,
  mergeConfigs,
  parseConfig,
  type TransportFactory,
} from "@ratel-ai/mcp-server";
import { ArgError, type ParsedArgs, parseArgs } from "./args.js";
import type { BackupFs } from "./backup.js";
import type { ClaudeFs } from "./claude.js";
import { runAdd } from "./handlers/add.js";
import { runEdit } from "./handlers/edit.js";
import { runMcpGet } from "./handlers/get.js";
import { runImport } from "./handlers/import.js";
import { runLink } from "./handlers/link.js";
import { runListBackups } from "./handlers/list.js";
import { runMcpAuth } from "./handlers/mcp-auth.js";
import { runMcpList } from "./handlers/mcp-list.js";
import { runRemove } from "./handlers/remove.js";
import type { HandlerCtx } from "./handlers/types.js";
import { runUndo } from "./handlers/undo.js";
import { findProjectRoot, type HierarchyEnv } from "./hierarchy.js";
import { type JsonFs, nodeFs } from "./io.js";
import { type PromptAdapter, silentPromptAdapter } from "./prompts.js";

export interface RunCliOptions {
  readConfig?: (path: string) => Promise<unknown>;
  transportFactory?: TransportFactory;
  serverTransport?: Transport;
  logger?: (message: string) => void;
  serverName?: string;
  serverVersion?: string;
  prompts?: PromptAdapter;
  fs?: JsonFs & BackupFs & ClaudeFs;
  env?: HierarchyEnv;
  now?: () => Date;
}

export interface RunCliResult {
  shutdown?: () => Promise<void>;
}

const TOP_USAGE = `usage: ratel <group> <verb> [args...]

Groups:
  mcp      manage MCP servers (add, remove, list, get, edit, import, link) and serve the gateway
  backup   manage backup snapshots (list)

Run \`ratel <group>\` for the verbs available in a group.`;

const MCP_USAGE = `usage: ratel mcp <verb> [args...]

Verbs:
  serve   start the gateway over stdio (use --config <path> to load a Ratel config; repeat for multi-file merge)
  add     add an MCP server entry (Claude-compatible: ratel mcp add [flags] <name> -- <command> [args...]
                                   or ratel mcp add [flags] <name> <url>)
  remove  remove an entry from a Ratel scope
  list    list MCP servers configured across Ratel scopes
  get     show one entry's resolved details
  edit    edit fields on an existing entry (interactive when no flags supplied)
  import  migrate Claude Code MCP configs into Ratel (two stages: Ratel write, then Claude rewrite)
  link    rewrite Claude Code's config to point at Ratel for entries already in Ratel scopes
  auth    drive an interactive OAuth flow for one or all http/sse upstreams that need authorization`;

const BACKUP_USAGE = `usage: ratel backup <verb> [args...]

Verbs:
  list    list backup sets under ~/.ratel/backups/`;

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
  const log = options.logger ?? ((m) => console.error(m));
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      log(`${err.message}\n${TOP_USAGE}`);
    }
    throw err;
  }

  if (parsed.group === "help") {
    log(TOP_USAGE);
    return {};
  }

  if (parsed.group === "mcp" && parsed.verb === undefined) {
    log(MCP_USAGE);
    return {};
  }

  if (parsed.group === "backup" && parsed.verb === undefined) {
    log(BACKUP_USAGE);
    return {};
  }

  if (parsed.group === "mcp" && parsed.verb === "serve") {
    return runServer(parsed, options, log);
  }

  const ctx: HandlerCtx = {
    argv: parsed,
    env: options.env ?? defaultEnv(),
    fs: options.fs ?? nodeFs,
    log,
    prompts: options.prompts ?? silentPromptAdapter(),
  };

  if (parsed.group === "mcp") {
    switch (parsed.verb) {
      case "add":
        await runAdd(ctx);
        return {};
      case "remove":
        await runRemove(ctx);
        return {};
      case "list":
        await runMcpList(ctx);
        return {};
      case "get":
        await runMcpGet(ctx);
        return {};
      case "edit":
        await runEdit(ctx);
        return {};
      case "import":
        await runImport(ctx, {
          yes: parsed.flags.yes === true,
          dryRun: parsed.flags["dry-run"] === true,
        });
        return {};
      case "link":
        await runLink(ctx, { yes: parsed.flags.yes === true });
        return {};
      case "auth":
        await runMcpAuth(ctx);
        return {};
      default:
        throw new ArgError(`unknown mcp verb: ${parsed.verb}`);
    }
  }

  if (parsed.group === "backup") {
    switch (parsed.verb) {
      case "list":
        await runListBackups(ctx);
        return {};
      case "undo":
        await runUndo(ctx);
        return {};
      default:
        throw new ArgError(`unknown backup verb: ${parsed.verb}`);
    }
  }

  throw new ArgError(`unhandled command: ${parsed.group} ${parsed.verb}`);
}

async function runServer(
  parsed: ParsedArgs,
  options: RunCliOptions,
  log: (m: string) => void,
): Promise<RunCliResult> {
  if (parsed.configPaths.length === 0) {
    throw new Error("usage: ratel mcp serve <config.json> [--config <path> ...]");
  }

  const readConfig = options.readConfig ?? defaultReadConfig;
  const parts = [];
  for (const p of parsed.configPaths) {
    const raw = await readConfig(p);
    parts.push(parseConfig(raw));
  }
  const config = mergeConfigs(parts);

  const gateway = await buildGatewayFromConfig(config, {
    transportFactory: options.transportFactory,
    logger: log,
  });

  const downstream = options.serverTransport ?? new StdioServerTransport();
  const exposed = await createMcpServer(gateway.catalog, {
    name: options.serverName ?? "ratel",
    version: options.serverVersion ?? "0.0.0",
    transport: downstream,
    upstreamServers: gateway.upstreamServers,
    runAuthFlow: gateway.runAuthFlow,
  });
  gateway.setListChangedNotifier(exposed.notifyToolListChanged);

  const upstreamCount = Object.keys(config.mcpServers).length;
  log(`[ratel] ready, ${upstreamCount} upstream server(s) configured`);

  return {
    shutdown: async () => {
      await exposed.close();
      await gateway.close();
    },
  };
}

async function defaultReadConfig(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { mcpServers: {} };
    }
    throw err;
  }
}

function defaultEnv(): HierarchyEnv {
  const env: HierarchyEnv = { homeDir: homedir() };
  try {
    env.projectRoot = findProjectRoot(process.cwd(), { existsSync });
  } catch {
    // no project root; project/local scopes will surface a clear error when used
  }
  return env;
}
