import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ArgError, type ParsedArgs, parseArgs } from "./args.js";
import type { BackupFs } from "./backup.js";
import type { ClaudeFs } from "./claude.js";
import { mergeConfigs, parseConfig } from "./config.js";
import { buildGatewayFromConfig, type TransportFactory } from "./gateway.js";
import { runAdd } from "./handlers/add.js";
import { runEdit } from "./handlers/edit.js";
import { runImport } from "./handlers/import.js";
import { runLink } from "./handlers/link.js";
import { runListBackups } from "./handlers/list.js";
import { runRemove } from "./handlers/remove.js";
import type { HandlerCtx } from "./handlers/types.js";
import { runUndo } from "./handlers/undo.js";
import { findProjectRoot, type HierarchyEnv } from "./hierarchy.js";
import { type JsonFs, nodeFs } from "./io.js";
import { type PromptAdapter, silentPromptAdapter } from "./prompts.js";
import { createMcpServer } from "./server.js";

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

const USAGE = `usage: ratel-mcp-server [<subcommand>] [--config <path> ...]

Subcommands:
  run                            (default) start the gateway over stdio
  import                         migrate Claude Code MCP configs into Ratel (two stages: Ratel write, then Claude rewrite)
  link                           rewrite Claude to point at Ratel for entries already in Ratel scopes
  add    --scope <s> --name <n>  add an entry to a Ratel scope (--command or --entry-json; optional --description)
  edit   --scope <s> --name <n>  edit fields on an existing Ratel entry (--description, --command, --arg, --env KEY=VAL,
                                 --cwd, --url, --header KEY=VAL, --entry-json; interactive when no flags supplied)
  remove --scope <s> --name <n>  remove an entry from a Ratel scope
  list                           list backup sets under ~/.ratel/backups
  undo                           restore the most recent backup set
  help                           show this message

Pass --config repeatedly for multi-file run; right-most wins on key collision.`;

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
  const log = options.logger ?? ((m) => console.error(m));
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      log(`${err.message}\n${USAGE}`);
    }
    throw err;
  }

  if (parsed.subcommand === "help") {
    log(USAGE);
    return {};
  }

  if (parsed.subcommand === "run") {
    return runServer(parsed, options, log);
  }

  const ctx: HandlerCtx = {
    argv: parsed,
    env: options.env ?? defaultEnv(),
    fs: options.fs ?? nodeFs,
    log,
    prompts: options.prompts ?? silentPromptAdapter(),
  };

  switch (parsed.subcommand) {
    case "list":
      await runListBackups(ctx);
      return {};
    case "undo":
      await runUndo(ctx);
      return {};
    case "add":
      await runAdd(ctx);
      return {};
    case "edit":
      await runEdit(ctx);
      return {};
    case "remove":
      await runRemove(ctx);
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
    default:
      throw new ArgError(`unknown subcommand: ${parsed.subcommand}`);
  }
}

async function runServer(
  parsed: ParsedArgs,
  options: RunCliOptions,
  log: (m: string) => void,
): Promise<RunCliResult> {
  if (parsed.configPaths.length === 0) {
    throw new Error("usage: ratel-mcp-server <config.json>");
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
  });

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
