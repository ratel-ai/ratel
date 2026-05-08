import { existsSync, readFileSync } from "node:fs";
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
import { refreshIfNeeded } from "./oauth/refresh.js";
import { RatelOAuthStore } from "./oauth/store.js";
import { wrapTransportWithSendMutex } from "./oauth/transport-mutex.js";

export type TransportFactory = (name: string, entry: ServerEntry) => Transport | undefined;

/**
 * Optional injection point for token refresh during gateway boot. The default is
 * `refreshIfNeeded` against the upstream's on-disk OAuth store; tests stub it.
 * Throw `RefreshFailedError` (or any error) to signal the upstream needs re-auth.
 */
export type RefreshTokensFn = (store: RatelOAuthStore, name: string) => Promise<unknown>;

export interface BuildGatewayOptions {
  transportFactory?: TransportFactory;
  logger?: (message: string) => void;
  /** Override the per-upstream OAuth state path. Defaults to `~/.ratel/oauth/<name>.json`. */
  oauthStorePath?: (serverName: string) => string;
  /** Override the auth-flow step (mainly for tests / DI). */
  authStep?: AuthStep;
  /** Override boot-time token refresh. Default: refreshIfNeeded against the upstream's store. */
  refreshTokens?: RefreshTokensFn;
}

const PLACEHOLDER_REDIRECT_URL = "http://127.0.0.1:0/cb";

const AUTH_SHAPED_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /prepareTokenRequest/i,
  /authorizationCode is required/i,
  /invalid_grant/i,
];

function isAuthShapedError(err: unknown): boolean {
  const msg = (err as { message?: unknown } | null)?.message;
  if (typeof msg !== "string") return false;
  return AUTH_SHAPED_ERROR_PATTERNS.some((re) => re.test(msg));
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
  const refreshTokens = options.refreshTokens ?? defaultRefreshTokens;

  const catalog = new ToolCatalog();
  const handles = new Map<string, McpServerHandle>();
  const upstreamServers: UpstreamServerInfo[] = [];
  const configEntries: Record<string, ServerEntry> = { ...config.mcpServers };
  let listChangedNotifier: (() => void | Promise<void>) | undefined;

  for (const [name, entry] of Object.entries(config.mcpServers)) {
    if (isHttpOrSse(entry)) {
      const store = new RatelOAuthStore(storePath(name));
      const hadTokens = (await store.load()).tokens !== undefined;
      if (hadTokens) {
        try {
          await refreshTokens(store, name);
        } catch (err) {
          markNeedsAuth(upstreamServers, name, entry);
          log(
            `[ratel] ${name} needs re-authorization (refresh failed: ${(err as Error).message}) — run "ratel mcp auth ${name}"`,
          );
          continue;
        }
      }
    }

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
      if (isUnauthorized(err) || (isHttpOrSse(entry) && isAuthShapedError(err))) {
        markNeedsAuth(upstreamServers, name, entry);
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
  const path = defaultOAuthStorePath(name);
  if (existsSync(path)) {
    const store = new RatelOAuthStore(path);
    const provider = new RatelOAuthProvider({
      store,
      // Always set redirectUrl so the SDK takes the refresh-token branch instead of
      // the prepareTokenRequest non-interactive path. See SDK auth.js line 259.
      redirectUrl: redirectUrlFromStoredFile(path) ?? PLACEHOLDER_REDIRECT_URL,
      scope: entry.scope,
      staticClientId: entry.clientId,
      staticClientSecret: entry.clientSecret,
    });
    return new StreamableHTTPClientTransport(url, { ...opts, authProvider: provider });
  }
  return new StreamableHTTPClientTransport(url, opts);
}

/** Test seam: read `client_information.redirect_uris[0]` from an on-disk OAuth store. */
export function redirectUrlFromStoredFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      client_information?: { redirect_uris?: unknown };
    };
    const list = parsed.client_information?.redirect_uris;
    if (Array.isArray(list) && typeof list[0] === "string") return list[0];
  } catch {
    // ignore — placeholder will be used
  }
  return undefined;
}

function isUnauthorized(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  const name = (err as { name?: string } | null)?.name;
  return name === "UnauthorizedError";
}

function isHttpOrSse(entry: ServerEntry): boolean {
  return entry.type === "http" || entry.type === "sse";
}

function markNeedsAuth(
  upstreamServers: UpstreamServerInfo[],
  name: string,
  entry: ServerEntry,
): void {
  const info: UpstreamServerInfo = { name, needsAuth: true };
  if (entry.description) info.description = entry.description;
  upstreamServers.push(info);
}

const defaultRefreshTokens: RefreshTokensFn = async (store) => {
  await refreshIfNeeded(store);
};
