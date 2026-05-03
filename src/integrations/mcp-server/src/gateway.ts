import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type McpServerHandle, registerMcpServer, ToolCatalog } from "@ratel-ai/sdk";
import type { RatelConfig, ServerEntry } from "./config.js";

export type TransportFactory = (name: string, entry: ServerEntry) => Transport | undefined;

export interface BuildGatewayOptions {
  transportFactory?: TransportFactory;
  logger?: (message: string) => void;
}

export interface GatewayHandle {
  catalog: ToolCatalog;
  close: () => Promise<void>;
}

export async function buildGatewayFromConfig(
  config: RatelConfig,
  options: BuildGatewayOptions = {},
): Promise<GatewayHandle> {
  const factory = options.transportFactory ?? defaultTransportFactory;
  const log = options.logger ?? ((m) => console.error(m));

  const catalog = new ToolCatalog();
  const upstreamHandles: McpServerHandle[] = [];

  for (const [name, entry] of Object.entries(config.mcpServers)) {
    try {
      const transport = factory(name, entry);
      if (!transport) {
        log(`[ratel] skipping ${name}: unsupported transport type "${entry.type}"`);
        continue;
      }
      const handle = await registerMcpServer(catalog, { name, transport });
      upstreamHandles.push(handle);
    } catch (err) {
      log(`[ratel] failed to register ${name}: ${(err as Error).message}`);
    }
  }

  return {
    catalog,
    close: async () => {
      const results = await Promise.allSettled(upstreamHandles.map((h) => h.close()));
      for (const r of results) {
        if (r.status === "rejected") {
          log(`[ratel] error during shutdown: ${(r.reason as Error)?.message ?? r.reason}`);
        }
      }
    },
  };
}

export const defaultTransportFactory: TransportFactory = (_name, entry) => {
  switch (entry.type) {
    case "stdio":
      if (!entry.command) return undefined;
      return new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: entry.env,
        cwd: entry.cwd,
        stderr: "inherit",
      });
    case "http":
      if (!entry.url) return undefined;
      return new StreamableHTTPClientTransport(new URL(entry.url), {
        requestInit: entry.headers ? { headers: entry.headers } : undefined,
      });
    default:
      return undefined;
  }
};
