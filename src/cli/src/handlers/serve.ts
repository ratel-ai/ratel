import { mkdir, readFile } from "node:fs/promises";
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
import type { ParsedArgs } from "../args.js";
import { defaultTelemetryDir, projectBucketDir } from "../inspect.js";

export interface ServeOptions {
  readConfig?: (path: string) => Promise<unknown>;
  transportFactory?: TransportFactory;
  serverTransport?: Transport;
  serverName?: string;
  serverVersion?: string;
}

export interface ServeResult {
  shutdown: () => Promise<void>;
}

export async function runServe(
  parsed: ParsedArgs,
  options: ServeOptions,
  log: (m: string) => void,
): Promise<ServeResult> {
  if (parsed.configPaths.length === 0) {
    throw new Error("usage: ratel serve <config.json> [--config <path> ...]");
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
