import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type AuthStep,
  defaultAuthStep,
  defaultOAuthStorePath,
  type ServerEntry,
} from "@ratel-ai/mcp-server";
import { ToolCatalog } from "@ratel-ai/sdk";

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

export interface AuthProbeOptions {
  /** Inject a custom AuthStep (tests stub this to skip the loopback flow). */
  authStep?: AuthStep;
  /** Override `~/.ratel/oauth/<name>.json` path. */
  storePath?: (serverName: string) => string;
  /** Override the user-action timeout for the loopback callback. */
  callbackTimeoutMs?: number;
  /** Sink for human-readable auth-flow progress messages. */
  logger?: (m: string) => void;
}

export interface AuthProbeResult {
  status: "authorized" | "failed" | "skipped";
  reason?: string;
  /** `serverInstructions` from the upstream when the flow succeeds. */
  instructions?: string;
}

/**
 * One-shot OAuth + register pass for an HTTP/SSE entry. Wraps `defaultAuthStep`
 * so `ratel mcp add` can persist tokens and capture the upstream's instructions
 * at add-time. The handle returned by the underlying step is closed before we
 * return — the catalog we register into is discarded; `ratel serve` will
 * re-register against fresh transports using the just-persisted tokens.
 */
export async function authProbeEntry(
  name: string,
  entry: ServerEntry,
  options: AuthProbeOptions = {},
): Promise<AuthProbeResult> {
  const step =
    options.authStep ??
    defaultAuthStep({
      logger: options.logger,
      storePath: options.storePath ?? defaultOAuthStorePath,
      callbackTimeoutMs: options.callbackTimeoutMs,
    });

  const catalog = new ToolCatalog();
  let result: Awaited<ReturnType<AuthStep>>;
  try {
    result = await step(name, entry, { catalog, logger: options.logger });
  } catch (err) {
    return { status: "failed", reason: (err as Error).message };
  }

  if (result.status !== "authorized") {
    return { status: result.status, reason: result.reason };
  }

  try {
    await result.handle.close();
  } catch {
    // best-effort; tokens are already persisted by the step.
  }
  const out: AuthProbeResult = { status: "authorized" };
  if (result.instructions !== undefined) out.instructions = result.instructions;
  return out;
}
