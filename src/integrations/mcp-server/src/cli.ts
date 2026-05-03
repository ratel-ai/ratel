import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { parseConfig } from "./config.js";
import { buildGatewayFromConfig, type TransportFactory } from "./gateway.js";
import { createMcpServer } from "./server.js";

export interface RunCliOptions {
  readConfig?: (path: string) => Promise<unknown>;
  transportFactory?: TransportFactory;
  serverTransport?: Transport;
  logger?: (message: string) => void;
  serverName?: string;
  serverVersion?: string;
}

export interface RunCliResult {
  shutdown: () => Promise<void>;
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
  if (argv.length < 1) {
    throw new Error("usage: ratel-mcp-server <config.json>");
  }
  const [configPath] = argv;

  const readConfig = options.readConfig ?? defaultReadConfig;
  const log = options.logger ?? ((m) => console.error(m));

  const raw = await readConfig(configPath);
  const config = parseConfig(raw);

  const gateway = await buildGatewayFromConfig(config, {
    transportFactory: options.transportFactory,
    logger: log,
  });

  const downstream = options.serverTransport ?? new StdioServerTransport();
  const exposed = await createMcpServer(gateway.catalog, {
    name: options.serverName ?? "ratel",
    version: options.serverVersion ?? "0.0.0",
    transport: downstream,
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
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}
