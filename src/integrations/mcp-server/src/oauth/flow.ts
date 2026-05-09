import { homedir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolCatalog, UpstreamServerInfo } from "@ratel-ai/sdk";
import { type McpServerHandle, registerMcpServer } from "@ratel-ai/sdk";
import type { ServerEntry } from "../config.js";
import { type CallbackHandle, startOAuthCallback } from "./callback-server.js";
import { RatelOAuthProvider } from "./provider.js";
import { refreshIfNeeded } from "./refresh.js";
import { RatelOAuthStore } from "./store.js";
import { wrapTransportWithSendMutex } from "./transport-mutex.js";

export type AuthMode = "refresh" | "interactive";

export interface AuthFlowOptions {
  /** Restrict the run to a single named upstream. Without it, every upstream marked needsAuth runs. */
  name?: string;
}

export interface AuthFlowResult {
  name: string;
  status: "authorized" | "skipped" | "failed";
  reason?: string;
  /** Which path produced this row (only meaningful when status === "authorized"). */
  mode?: AuthMode;
}

export interface AuthStepSuccess {
  status: "authorized";
  handle: McpServerHandle;
  description?: string;
  instructions?: string;
  /** "refresh" if a stored refresh_token was rotated; "interactive" if a PKCE flow ran. */
  mode: AuthMode;
}

export interface AuthStepFailure {
  status: "failed";
  reason: string;
}

export interface AuthStepSkip {
  status: "skipped";
  reason: string;
}

export type AuthStepResult = AuthStepSuccess | AuthStepFailure | AuthStepSkip;

export interface AuthStepCtx {
  catalog: ToolCatalog;
  logger?: (m: string) => void;
}

export type AuthStep = (
  name: string,
  entry: ServerEntry,
  ctx: AuthStepCtx,
) => Promise<AuthStepResult>;

export interface RunAuthFlowDeps {
  catalog: ToolCatalog;
  upstreams: UpstreamServerInfo[];
  handles: Map<string, McpServerHandle>;
  configEntries: Record<string, ServerEntry>;
  step: AuthStep;
  opts?: AuthFlowOptions;
  onListChanged?: () => void | Promise<void>;
  logger?: (m: string) => void;
}

export async function runAuthFlow(deps: RunAuthFlowDeps): Promise<AuthFlowResult[]> {
  const { upstreams, configEntries, opts = {}, logger } = deps;

  if (opts.name !== undefined) {
    const entry = configEntries[opts.name];
    if (!entry) {
      return [{ name: opts.name, status: "failed", reason: "unknown upstream" }];
    }
    if (entry.type !== "http" && entry.type !== "sse") {
      return [{ name: opts.name, status: "skipped", reason: "stdio entries do not use OAuth" }];
    }
    return [await runOne(deps, opts.name, entry)];
  }

  const targets = upstreams
    .filter((u) => u.needsAuth)
    .map((u) => u.name)
    .filter((name) => {
      const e = configEntries[name];
      return !!e && (e.type === "http" || e.type === "sse");
    });

  const results: AuthFlowResult[] = [];
  for (const name of targets) {
    const entry = configEntries[name];
    if (!entry) {
      logger?.(`[ratel] auth flow skipping ${name}: no config entry`);
      continue;
    }
    results.push(await runOne(deps, name, entry));
  }
  return results;
}

async function runOne(
  deps: RunAuthFlowDeps,
  name: string,
  entry: ServerEntry,
): Promise<AuthFlowResult> {
  const { catalog, upstreams, handles, step, onListChanged, logger } = deps;

  catalog.recordEvent({ type: "auth_flow_start", upstream: name });
  let result: AuthStepResult;
  try {
    result = await step(name, entry, { catalog, logger });
  } catch (err) {
    catalog.recordEvent({ type: "auth_flow_end", upstream: name, ok: false });
    return { name, status: "failed", reason: (err as Error).message };
  }

  if (result.status !== "authorized") {
    catalog.recordEvent({ type: "auth_flow_end", upstream: name, ok: false });
    return { name, status: result.status, reason: result.reason };
  }
  catalog.recordEvent({ type: "auth_flow_end", upstream: name, ok: true });

  const previous = handles.get(name);
  if (previous) {
    try {
      await previous.close();
    } catch (err) {
      logger?.(`[ratel] error closing previous ${name} handle: ${(err as Error).message}`);
    }
  }
  handles.set(name, result.handle);

  let info = upstreams.find((u) => u.name === name);
  if (!info) {
    info = { name };
    upstreams.push(info);
  }
  info.needsAuth = false;
  info.toolCount = result.handle.toolIds.length;
  if (result.description !== undefined) info.description = result.description;
  if (result.instructions !== undefined) info.instructions = result.instructions;

  await onListChanged?.();

  return { name, status: "authorized", mode: result.mode };
}

/** Default location for per-upstream OAuth state. */
export function defaultOAuthStorePath(serverName: string): string {
  return join(homedir(), ".ratel", "oauth", `${serverName}.json`);
}

export interface DefaultAuthStepDeps {
  /** Override the OAuth store path. Defaults to `~/.ratel/oauth/<name>.json`. */
  storePath?: (serverName: string) => string;
  /** Override the browser launcher. Defaults to dynamic-import of the `open` package. */
  browserLauncher?: (url: URL) => void | Promise<void>;
  /** Override the callback server. Tests can stub. */
  callbackFactory?: typeof startOAuthCallback;
  /** Logger sink. Defaults to console.error. */
  logger?: (m: string) => void;
  /** Override the timeout for the user to complete the authorization step. */
  callbackTimeoutMs?: number;
  /** Test seam: refresh stored tokens before falling back to PKCE. Defaults to refreshIfNeeded. */
  refreshTokens?: (store: RatelOAuthStore, name: string) => Promise<unknown>;
  /**
   * Test seam: full body of the interactive PKCE flow. Defaults to runPkceFlow.
   * Allows tests to assert the refresh-vs-interactive branching without spinning
   * up real loopback servers and SDK transports.
   */
  pkceFlow?: PkceFlowFn;
  /**
   * Test seam: replace registerMcpServer when the refresh path succeeds. Defaults to
   * the real implementation. The full PKCE path uses pkceFlow's own register, not this.
   */
  registerMcpServerImpl?: typeof registerMcpServer;
  /**
   * Test seam: build the HTTP transport used by the refresh-success path. The default
   * constructs a StreamableHTTPClientTransport with the OAuth provider attached.
   */
  transportFactory?: (entry: ServerEntry, provider: RatelOAuthProvider) => Transport;
}

export interface PkceFlowDeps {
  storePath: (name: string) => string;
  browserLauncher: (url: URL) => void | Promise<void>;
  callbackFactory: typeof startOAuthCallback;
  logger: (m: string) => void;
  callbackTimeoutMs?: number;
}

export type PkceFlowFn = (
  name: string,
  entry: ServerEntry,
  ctx: AuthStepCtx,
  deps: PkceFlowDeps,
) => Promise<AuthStepResult>;

/**
 * Default `AuthStep` implementation: refresh-first. Tries `refreshTokens` against the
 * upstream's stored OAuth state; if that succeeds, registers the upstream's tools
 * with mode="refresh" — no callback server, no browser pop. Only when refresh is
 * impossible (no refresh_token) or fails does it fall back to the interactive PKCE
 * flow against a loopback callback server with mode="interactive".
 */
export function defaultAuthStep(deps: DefaultAuthStepDeps = {}): AuthStep {
  const storePath = deps.storePath ?? defaultOAuthStorePath;
  const callbackFactory = deps.callbackFactory ?? startOAuthCallback;
  const launcher = deps.browserLauncher ?? defaultBrowserLauncher;
  const log = deps.logger ?? ((m: string) => console.error(m));
  const refreshTokens = deps.refreshTokens ?? defaultRefreshTokens;
  const pkceFlow = deps.pkceFlow ?? runPkceFlow;
  const registerImpl = deps.registerMcpServerImpl ?? registerMcpServer;
  const transportFactory = deps.transportFactory ?? defaultRefreshTransportFactory;

  return async (name, entry, ctx): Promise<AuthStepResult> => {
    if (!entry.url) {
      return { status: "failed", reason: `${name}: http/sse entry has no url` };
    }

    // Refresh-first: attempt a silent refresh with the stored refresh_token. If it
    // succeeds, connect with fresh credentials and register — no browser involved.
    const store = new RatelOAuthStore(storePath(name));
    const tokens = (await store.load()).tokens;
    const canRefresh = tokens?.refresh_token !== undefined;
    if (canRefresh) {
      try {
        await refreshTokens(store, name);
        const provider = new RatelOAuthProvider({
          store,
          redirectUrl: tokens?.refresh_token
            ? (await store.load()).client_information?.redirect_uris?.[0]
            : undefined,
          scope: entry.scope,
          staticClientId: entry.clientId,
          staticClientSecret: entry.clientSecret,
        });
        const tx = transportFactory(entry, provider);
        try {
          const handle = await registerImpl(ctx.catalog, { name, transport: tx });
          return successResult(handle, entry, "refresh");
        } catch (err) {
          await safeClose(tx);
          // Register failure after a successful refresh is unexpected — treat as
          // failed rather than retrying interactively, so the user sees the error.
          return {
            status: "failed",
            reason: `${name}: register after refresh failed: ${(err as Error).message}`,
          };
        }
      } catch (err) {
        log(`[ratel] ${name}: refresh failed (${(err as Error).message}), falling back to PKCE`);
        // Fall through to the interactive PKCE path below.
      }
    }

    return pkceFlow(name, entry, ctx, {
      storePath,
      browserLauncher: launcher,
      callbackFactory,
      logger: log,
      ...(deps.callbackTimeoutMs !== undefined && { callbackTimeoutMs: deps.callbackTimeoutMs }),
    });
  };
}

const defaultRefreshTokens = async (store: RatelOAuthStore): Promise<void> => {
  await refreshIfNeeded(store);
};

const defaultRefreshTransportFactory = (
  entry: ServerEntry,
  provider: RatelOAuthProvider,
): Transport => {
  if (!entry.url) throw new Error("missing url");
  return wrapTransportWithSendMutex(
    new StreamableHTTPClientTransport(new URL(entry.url), { authProvider: provider }),
  );
};

/** Interactive PKCE flow against a loopback callback server. */
export async function runPkceFlow(
  name: string,
  entry: ServerEntry,
  ctx: AuthStepCtx,
  deps: PkceFlowDeps,
): Promise<AuthStepResult> {
  const { storePath, browserLauncher: launcher, callbackFactory, logger: log } = deps;
  if (!entry.url) {
    return { status: "failed", reason: `${name}: http/sse entry has no url` };
  }
  let cb: CallbackHandle | undefined;
  try {
    cb = await callbackFactory({
      port: entry.callbackPort ?? 0,
      ...(deps.callbackTimeoutMs !== undefined && { timeoutMs: deps.callbackTimeoutMs }),
    });
  } catch (err) {
    return {
      status: "failed",
      reason: `${name}: callback server failed: ${(err as Error).message}`,
    };
  }

  try {
    const store = new RatelOAuthStore(storePath(name));
    const provider = new RatelOAuthProvider({
      store,
      redirectUrl: cb.url,
      scope: entry.scope,
      staticClientId: entry.clientId,
      staticClientSecret: entry.clientSecret,
      onRedirect: async (u) => {
        log(`[ratel] open ${u} to authorize ${name}`);
        try {
          await launcher(u);
        } catch (err) {
          log(`[ratel] could not open browser automatically: ${(err as Error).message}`);
        }
      },
    });

    const tx1 = wrapTransportWithSendMutex(
      new StreamableHTTPClientTransport(new URL(entry.url), { authProvider: provider }),
    );
    try {
      const handle = await registerMcpServer(ctx.catalog, { name, transport: tx1 });
      return successResult(handle, entry, "interactive");
    } catch (err) {
      if (!isUnauthorized(err)) {
        await safeClose(tx1);
        return { status: "failed", reason: (err as Error).message };
      }
    }
    await safeClose(tx1);

    let code: string;
    try {
      const captured = await cb.waitForCode();
      code = captured.code;
    } catch (err) {
      return { status: "failed", reason: `${name}: ${(err as Error).message}` };
    }

    const tx2 = new StreamableHTTPClientTransport(new URL(entry.url), { authProvider: provider });
    try {
      await tx2.finishAuth(code);
    } catch (err) {
      await safeClose(tx2);
      return {
        status: "failed",
        reason: `${name}: token exchange failed: ${(err as Error).message}`,
      };
    }
    await safeClose(tx2);

    const tx3 = wrapTransportWithSendMutex(
      new StreamableHTTPClientTransport(new URL(entry.url), { authProvider: provider }),
    );
    try {
      const handle = await registerMcpServer(ctx.catalog, { name, transport: tx3 });
      return successResult(handle, entry, "interactive");
    } catch (err) {
      await safeClose(tx3);
      return { status: "failed", reason: `${name}: register failed: ${(err as Error).message}` };
    }
  } finally {
    if (cb) await cb.close().catch(() => undefined);
  }
}

function successResult(
  handle: McpServerHandle,
  entry: ServerEntry,
  mode: AuthMode,
): AuthStepSuccess {
  const result: AuthStepSuccess = { status: "authorized", handle, mode };
  const description = entry.description ?? handle.serverInstructions;
  if (description !== undefined) result.description = description;
  if (handle.serverInstructions !== undefined) result.instructions = handle.serverInstructions;
  return result;
}

function isUnauthorized(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  const name = (err as { name?: string } | null)?.name;
  return name === "UnauthorizedError";
}

async function safeClose(t: { close: () => Promise<void> }): Promise<void> {
  try {
    await t.close();
  } catch {
    // best-effort
  }
}

const defaultBrowserLauncher = async (url: URL): Promise<void> => {
  // Lazy import so test environments and headless installs don't pay the cost.
  const mod = (await import("node:child_process")) as typeof import("node:child_process");
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const args = platform === "win32" ? ["", String(url)] : [String(url)];
  const child = mod.spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
};
