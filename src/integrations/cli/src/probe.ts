import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerEntry } from "@ratel-ai/mcp-server";

export interface ProbeOptions {
  transportFactory?: (name: string, entry: ServerEntry) => Transport | undefined;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;

const silentTransportFactory = (_name: string, entry: ServerEntry): Transport | undefined => {
  switch (entry.type) {
    case "stdio":
      if (!entry.command) return undefined;
      return new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: entry.env,
        cwd: entry.cwd,
        stderr: "ignore",
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

export async function probeEntryInstructions(
  name: string,
  entry: ServerEntry,
  options: ProbeOptions = {},
): Promise<string | undefined> {
  const factory = options.transportFactory ?? silentTransportFactory;
  let transport: Transport | undefined;
  try {
    transport = factory(name, entry);
  } catch {
    return undefined;
  }
  if (!transport) return undefined;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new Client({ name: "@ratel-ai/cli probe", version: "0.0.0" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("probe timeout")), timeoutMs);
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    return client.getInstructions();
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await client.close();
    } catch {
      // ignore close errors after a failed probe
    }
  }
}
