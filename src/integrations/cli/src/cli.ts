import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  buildGatewayFromConfig,
  createMcpServer,
  mergeConfigs,
  parseConfig,
  type TransportFactory,
} from "@ratel-ai/mcp-server";
import type { TraceSinkConfig } from "@ratel-ai/sdk";
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
import {
  defaultTelemetryDir,
  listSessions,
  projectBucketDir,
  summarizeSession,
} from "./inspect.js";
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
  inspect  summarize the most recent telemetry session (or \`ls\` for a file listing)

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

const INSPECT_USAGE = `usage: ratel inspect [verb] [args...]

Default (no verb) summarizes the most recent telemetry file in the bucket for
the current cwd, under \`$RATEL_TELEMETRY_DIR/<project-slug>/\` (default root
\`~/.ratel/telemetry/\`). The slug mirrors Claude Code's \`~/.claude/projects/\`
convention: every \`/\` and \`.\` in the absolute path becomes \`-\`.

Flags:
  --from <FILE>          summarize a specific JSONL file
  --last <N>             restrict the summary to the last N events
  --project <ABS-PATH>   target another project's bucket explicitly
  --all                  scan every bucket and pick the global newest

Verbs:
  ls   list telemetry files in the cwd's bucket (most recent first; use --all to enumerate every bucket)`;

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

  if (parsed.group === "inspect") {
    return runInspect(parsed, log);
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

  const trace = await resolveTraceSink(parsed, log);

  const gateway = await buildGatewayFromConfig(config, {
    transportFactory: options.transportFactory,
    logger: log,
    ...(trace ? { trace } : {}),
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

async function runInspect(parsed: ParsedArgs, log: (m: string) => void): Promise<RunCliResult> {
  if (parsed.flags.help === true) {
    log(INSPECT_USAGE);
    return {};
  }
  const all = parsed.flags.all === true;
  const projectFlag = parsed.flags.project;
  const project = typeof projectFlag === "string" ? projectFlag : undefined;
  if (parsed.verb === "ls") {
    const listOpts: { project?: string; all?: boolean } = {};
    if (all) listOpts.all = true;
    if (project) listOpts.project = project;
    log(await listSessions(defaultTelemetryDir(), listOpts));
    return {};
  }
  const opts: { from?: string; last?: number; project?: string; all?: boolean } = {};
  const from = parsed.flags.from;
  if (typeof from === "string") opts.from = from;
  const last = parsed.flags.last;
  if (typeof last === "string") {
    const n = Number.parseInt(last, 10);
    if (Number.isFinite(n)) opts.last = n;
  }
  if (all) opts.all = true;
  if (project) opts.project = project;
  log(await summarizeSession(opts));
  return {};
}

async function resolveTraceSink(
  parsed: ParsedArgs,
  log: (m: string) => void,
): Promise<TraceSinkConfig | undefined> {
  const flag = parsed.flags.telemetry;
  const flagFile = parsed.flags["telemetry-file"];
  const env = process.env.RATEL_TELEMETRY;
  if (flag === false || flag === "off" || env === "off") {
    return { kind: "noop" };
  }
  const sessionId = newSessionId();
  if (typeof flagFile === "string" && flagFile.length > 0) {
    return { kind: "jsonl", sessionId, path: flagFile };
  }
  const bucket = projectBucketDir(defaultTelemetryDir(), process.cwd());
  try {
    await mkdir(bucket, { recursive: true });
  } catch (err) {
    log(`[ratel] could not create telemetry dir ${bucket}: ${(err as Error).message}; disabling`);
    return { kind: "noop" };
  }
  const path = join(bucket, `${sessionId}.jsonl`);
  return { kind: "jsonl", sessionId, path };
}

function newSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
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
