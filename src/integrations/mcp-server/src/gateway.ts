import { existsSync } from "node:fs";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type McpServerHandle,
  registerMcpServer,
  ToolCatalog,
  type UpstreamServerInfo,
} from "@ratel-ai/sdk";
import type { RatelConfig, ServerEntry } from "./config.js";
import {
  type AuthFlowOptions,
  type AuthFlowResult,
  type AuthStep,
  defaultAuthStep,
  defaultOAuthStorePath,
  runAuthFlow,
} from "./oauth/flow.js";
import { RatelOAuthProvider } from "./oauth/provider.js";
import { RatelOAuthStore } from "./oauth/store.js";
import { wrapTransportWithSendMutex } from "./oauth/transport-mutex.js";

export type TransportFactory = (name: string, entry: ServerEntry) => Transport | undefined;

export interface BuildGatewayOptions {
  transportFactory?: TransportFactory;
  logger?: (message: string) => void;
  /** Override the per-upstream OAuth state path. Defaults to `~/.ratel/oauth/<name>.json`. */
  oauthStorePath?: (serverName: string) => string;
  /** Override the auth-flow step (mainly for tests / DI). */
  authStep?: AuthStep;
}

export interface GatewayHandle {
  catalog: ToolCatalog;
  upstreamServers: UpstreamServerInfo[];
  close: () => Promise<void>;
  /** Drives an interactive OAuth flow for one or all upstreams marked `needsAuth`. */
  runAuthFlow: (opts?: AuthFlowOptions) => Promise<AuthFlowResult[]>;
  /** Wires a `notifications/tools/list_changed` emitter; called after each successful auth. */
  setListChangedNotifier: (fn: (() => void | Promise<void>) | undefined) => void;
}

export async function buildGatewayFromConfig(
  config: RatelConfig,
  options: BuildGatewayOptions = {},
): Promise<GatewayHandle> {
  const factory = options.transportFactory ?? defaultTransportFactory;
  const log = options.logger ?? ((m) => console.error(m));
  const storePath = options.oauthStorePath ?? defaultOAuthStorePath;
  const step = options.authStep ?? defaultAuthStep({ logger: log, storePath });

  const catalog = new ToolCatalog();
  const handles = new Map<string, McpServerHandle>();
  const upstreamServers: UpstreamServerInfo[] = [];
  const configEntries: Record<string, ServerEntry> = { ...config.mcpServers };
  let listChangedNotifier: (() => void | Promise<void>) | undefined;

  for (const [name, entry] of Object.entries(config.mcpServers)) {
    try {
      const transport = factory(name, entry);
      if (!transport) {
        log(`[ratel] skipping ${name}: unsupported transport type "${entry.type}"`);
        continue;
      }
      const handle = await registerMcpServer(catalog, { name, transport });
      handles.set(name, handle);
      const info: UpstreamServerInfo = { name, toolCount: handle.toolIds.length };
      const description = entry.description ?? handle.serverInstructions;
      if (description) info.description = description;
      if (handle.serverInstructions) info.instructions = handle.serverInstructions;
      upstreamServers.push(info);
    } catch (err) {
      if (isUnauthorized(err)) {
        const info: UpstreamServerInfo = { name, needsAuth: true };
        if (entry.description) info.description = entry.description;
        upstreamServers.push(info);
        log(
          `[ratel] ${name} requires authorization — run "ratel mcp auth ${name}" or call the auth tool`,
        );
        continue;
      }
      log(`[ratel] failed to register ${name}: ${(err as Error).message}`);
    }
  }

  return {
    catalog,
    upstreamServers,
    close: async () => {
      const results = await Promise.allSettled(Array.from(handles.values()).map((h) => h.close()));
      for (const r of results) {
        if (r.status === "rejected") {
          log(`[ratel] error during shutdown: ${(r.reason as Error)?.message ?? r.reason}`);
        }
      }
    },
    runAuthFlow: (opts: AuthFlowOptions = {}) =>
      runAuthFlow({
        catalog,
        upstreams: upstreamServers,
        handles,
        configEntries,
        step,
        opts,
        onListChanged: () => listChangedNotifier?.(),
        logger: log,
      }),
    setListChangedNotifier: (fn) => {
      listChangedNotifier = fn;
    },
  };
}

export const defaultTransportFactory: TransportFactory = (name, entry) => {
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
    case "sse":
      if (!entry.url) return undefined;
      return wrapTransportWithSendMutex(buildHttpTransport(name, entry));
    default:
      return undefined;
  }
};

function buildHttpTransport(name: string, entry: ServerEntry): Transport {
  const url = new URL(entry.url ?? "");
  const opts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = entry.headers
    ? { requestInit: { headers: entry.headers } }
    : {};
  if (hasStoredTokens(name)) {
    const store = new RatelOAuthStore(defaultOAuthStorePath(name));
    const provider = new RatelOAuthProvider({
      store,
      scope: entry.scope,
      staticClientId: entry.clientId,
      staticClientSecret: entry.clientSecret,
    });
    return new StreamableHTTPClientTransport(url, { ...opts, authProvider: provider });
  }
  return new StreamableHTTPClientTransport(url, opts);
}

function hasStoredTokens(name: string): boolean {
  try {
    return existsSync(defaultOAuthStorePath(name));
  } catch {
    return false;
  }
}

function isUnauthorized(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  const name = (err as { name?: string } | null)?.name;
  return name === "UnauthorizedError";
}
