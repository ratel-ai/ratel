import { timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface CallbackOpts {
  port?: number;
  expectedState?: string;
  timeoutMs?: number;
  pathPrefix?: string;
}

export interface CallbackResult {
  code: string;
  state?: string;
}

export interface CallbackHandle {
  url: string;
  port: number;
  waitForCode(): Promise<CallbackResult>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PATH = "/cb";
const HOST = "127.0.0.1";

const CALLBACK_HTML = `<!doctype html>
<html><head><title>Authorized</title></head>
<body style="font-family:system-ui;padding:2rem;">
<h2>Authorization complete</h2>
<p>You may close this window.</p>
</body></html>`;

export async function startOAuthCallback(opts: CallbackOpts = {}): Promise<CallbackHandle> {
  const path = opts.pathPrefix ?? DEFAULT_PATH;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let resolveCode: ((r: CallbackResult) => void) | undefined;
  let rejectCode: ((e: Error) => void) | undefined;
  let settled = false;

  const codePromise = new Promise<CallbackResult>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  // attach a no-op handler so an early rejection (e.g. close before waitForCode is awaited)
  // is not surfaced as an unhandled rejection. Awaiters still see the rejection on their copy.
  codePromise.catch(() => {});

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };

  const fail = (err: Error) => settle(() => rejectCode?.(err));
  const succeed = (r: CallbackResult) => settle(() => resolveCode?.(r));

  const server = createHttpServer((req, res) => {
    handleRequest(req, res, {
      path,
      expectedState: opts.expectedState,
      port: (server.address() as AddressInfo)?.port,
      onResult: (r) => {
        succeed(r);
        // close after responding so single-shot semantics hold
        setImmediate(() => server.close());
      },
      onError: (status, message) => {
        // Don't fail the promise on every malformed request — only on state mismatch
        // or missing code, which are diagnostic. The host-validation failure path
        // leaves the promise open so the caller can either time out or close.
        if (status === 400 && (message.includes("state") || message.includes("code"))) {
          fail(new Error(message));
          setImmediate(() => server.close());
        }
      },
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, HOST, () => resolve());
  });

  const port = (server.address() as AddressInfo).port;

  const timer = setTimeout(() => {
    fail(new Error(`OAuth callback timed out after ${timeoutMs}ms`));
    server.close();
  }, timeoutMs);
  timer.unref();

  const close = async () => {
    clearTimeout(timer);
    fail(new Error("OAuth callback server closed"));
    await closeServer(server);
  };

  return {
    url: `http://${HOST}:${port}${path}`,
    port,
    waitForCode: () => codePromise,
    close,
  };
}

interface HandleOpts {
  path: string;
  expectedState?: string;
  port: number;
  onResult: (r: CallbackResult) => void;
  onError: (status: number, message: string) => void;
}

function handleRequest(req: IncomingMessage, res: ServerResponse, opts: HandleOpts): void {
  if (!isLoopbackHost(req.headers.host, opts.port)) {
    respond(res, 400, "Invalid Host header");
    opts.onError(400, "host");
    return;
  }
  if (!req.url) {
    respond(res, 400, "Missing URL");
    opts.onError(400, "url");
    return;
  }
  const url = new URL(req.url, `http://${HOST}:${opts.port}`);
  if (url.pathname !== opts.path) {
    respond(res, 404, "Not found");
    return;
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? undefined;
  if (!code) {
    respond(res, 400, "Missing code parameter");
    opts.onError(400, "code missing");
    return;
  }
  if (opts.expectedState !== undefined) {
    if (!state || !constantTimeEqual(state, opts.expectedState)) {
      respond(res, 400, "Invalid state parameter");
      opts.onError(400, "state mismatch");
      return;
    }
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(CALLBACK_HTML);
  opts.onResult({ code, state });
}

function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  return allowed.includes(host.toLowerCase());
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function respond(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
