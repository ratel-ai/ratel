import { homedir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolCatalog, UpstreamServerInfo } from "@ratel-ai/sdk";
import { type McpServerHandle, registerMcpServer } from "@ratel-ai/sdk";
import type { ServerEntry } from "../config.js";
import { type CallbackHandle, startOAuthCallback } from "./callback-server.js";
import { RatelOAuthProvider } from "./provider.js";
import { RatelOAuthStore } from "./store.js";
import { wrapTransportWithSendMutex } from "./transport-mutex.js";

export interface AuthFlowOptions {
  /** Restrict the run to a single named upstream. Without it, every upstream marked needsAuth runs. */
  name?: string;
}

export interface AuthFlowResult {
  name: string;
  status: "authorized" | "skipped" | "failed";
  reason?: string;
}

export interface AuthStepSuccess {
  status: "authorized";
  handle: McpServerHandle;
  description?: string;
  instructions?: string;
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

  let result: AuthStepResult;
  try {
    result = await step(name, entry, { catalog, logger });
  } catch (err) {
    return { name, status: "failed", reason: (err as Error).message };
  }

  if (result.status !== "authorized") {
    return { name, status: result.status, reason: result.reason };
  }

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

  return { name, status: "authorized" };
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
}

/**
 * Default `AuthStep` implementation: drives the SDK's PKCE flow against an HTTP/SSE upstream
 * with a loopback callback server, opens the browser via the configured launcher, and
 * registers the upstream's tools into the catalog on success.
 */
export function defaultAuthStep(deps: DefaultAuthStepDeps = {}): AuthStep {
  const storePath = deps.storePath ?? defaultOAuthStorePath;
  const callbackFactory = deps.callbackFactory ?? startOAuthCallback;
  const launcher = deps.browserLauncher ?? defaultBrowserLauncher;
  const log = deps.logger ?? ((m: string) => console.error(m));

  return async (name, entry, ctx): Promise<AuthStepResult> => {
    if (!entry.url) {
      return { status: "failed", reason: `${name}: http/sse entry has no url` };
    }

    let cb: CallbackHandle | undefined;
    try {
      cb = await callbackFactory({
        port: entry.callbackPort ?? 0,
        timeoutMs: deps.callbackTimeoutMs,
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

      // First connect: either succeeds (existing tokens still valid) or throws UnauthorizedError after redirectToAuthorization fires.
      const tx1 = wrapTransportWithSendMutex(
        new StreamableHTTPClientTransport(new URL(entry.url), { authProvider: provider }),
      );
      try {
        const handle = await registerMcpServer(ctx.catalog, { name, transport: tx1 });
        return successResult(handle, entry);
      } catch (err) {
        if (!isUnauthorized(err)) {
          await safeClose(tx1);
          return { status: "failed", reason: (err as Error).message };
        }
      }
      await safeClose(tx1);

      // Wait for the authorization code to land on the loopback callback.
      let code: string;
      try {
        const captured = await cb.waitForCode();
        code = captured.code;
      } catch (err) {
        return { status: "failed", reason: `${name}: ${(err as Error).message}` };
      }

      // Exchange code → tokens. provider.saveTokens persists them for the next connect.
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

      // Reconnect with fresh tokens and register the upstream's tools.
      const tx3 = wrapTransportWithSendMutex(
        new StreamableHTTPClientTransport(new URL(entry.url), { authProvider: provider }),
      );
      try {
        const handle = await registerMcpServer(ctx.catalog, { name, transport: tx3 });
        return successResult(handle, entry);
      } catch (err) {
        await safeClose(tx3);
        return { status: "failed", reason: `${name}: register failed: ${(err as Error).message}` };
      }
    } finally {
      if (cb) await cb.close().catch(() => undefined);
    }
  };
}

function successResult(handle: McpServerHandle, entry: ServerEntry): AuthStepSuccess {
  const result: AuthStepSuccess = { status: "authorized", handle };
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
