import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { type WebSocket, WebSocketServer } from "ws";
import type { Envelope } from "../dev/protocol.js";

// A small in-process twin/v1 controller for tests: the token exchange endpoint
// and the gateway socket on one port. Every frame the worker sends is checked
// against the protocol schemas, and its replies start from the conformance
// fixtures. Test support only: it is not the Ratel gateway.

const PROTOCOL = fileURLToPath(new URL("../../../../../protocol/twin/v1/", import.meta.url));
const MESSAGE_SCHEMA = "https://ratel.sh/protocol/twin/v1/message.schema.json";

export const TEST_PROJECT_ID = "prj_test";

export interface ReceivedFrame {
  readonly connection: number;
  readonly token: string;
  readonly raw: string;
  readonly frame: Envelope;
}

export interface TestController {
  /** The base URL for `ratel dev --url`. */
  readonly url: string;
  /** Bearer values of each POST /api/v1/runner/connect, in order. */
  readonly exchanges: string[];
  /** Tokens of each socket the worker opened, in order. */
  readonly sockets: string[];
  readonly frames: ReceivedFrame[];
  /** Frames that failed schema validation, with the reason. */
  readonly invalid: { raw: string; errors: string }[];
  /** Answers each POST /connect with this status instead of a grant, while set. */
  failConnectWith: number | undefined;
  /** Waits until a received frame matches. */
  waitForFrame(match: (f: ReceivedFrame) => boolean, timeoutMs?: number): Promise<ReceivedFrame>;
  /** Drops every open socket without a close handshake. */
  dropAll(): void;
  /** Sends a frame on the newest open socket. */
  send(frame: Envelope): void;
  close(): Promise<void>;
}

export interface TestControllerOptions {
  /** Project keys the controller accepts. Default: any key. */
  readonly keys?: readonly string[];
}

export async function startTestController(
  options: TestControllerOptions = {},
): Promise<TestController> {
  const validate = loadValidator();
  const registered = fixture("registered.json");
  const http: Server = createServer((req, res) => handleHttp(req, res));
  const wss = new WebSocketServer({ noServer: true });
  const open = new Set<WebSocket>();
  let newest: WebSocket | undefined;
  let tokenCount = 0;
  const issued = new Set<string>();
  const waiters: { match: (f: ReceivedFrame) => boolean; resolve(f: ReceivedFrame): void }[] = [];

  const controller: TestController = {
    url: "",
    exchanges: [],
    sockets: [],
    frames: [],
    invalid: [],
    failConnectWith: undefined,
    waitForFrame: (match, timeoutMs = 15_000) => {
      const seen = controller.frames.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no matching frame within ${timeoutMs} ms`)),
          timeoutMs,
        );
        waiters.push({
          match,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      });
    },
    dropAll: () => {
      for (const ws of open) ws.terminate();
    },
    send: (frame) => newest?.send(JSON.stringify(frame)),
    close: async () => {
      for (const ws of open) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "POST" || req.url !== "/api/v1/runner/connect") {
      res.writeHead(404).end();
      return;
    }
    const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    controller.exchanges.push(key);
    if (controller.failConnectWith !== undefined) {
      res.writeHead(controller.failConnectWith).end();
      return;
    }
    if (!key || (options.keys && !options.keys.includes(key))) {
      res.writeHead(401).end();
      return;
    }
    const token = `tok_${++tokenCount}`;
    issued.add(token);
    const { port } = http.address() as AddressInfo;
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        gatewayUrl: `ws://127.0.0.1:${port}`,
        token,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        projectId: TEST_PROJECT_ID,
      }),
    );
  }

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    if (url.pathname !== "/runner" || !issued.has(token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    issued.delete(token);
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, token));
  });

  function accept(ws: WebSocket, token: string): void {
    const connection = controller.sockets.push(token);
    open.add(ws);
    newest = ws;
    ws.on("close", () => open.delete(ws));
    ws.on("message", (data) => {
      const raw = data.toString();
      const frame = JSON.parse(raw) as Envelope;
      if (!validate(frame)) {
        controller.invalid.push({ raw, errors: JSON.stringify(validate.errors) });
      }
      const received = { connection, token, raw, frame };
      controller.frames.push(received);
      for (const waiter of [...waiters]) {
        if (!waiter.match(received)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(received);
      }
      if (frame.type === "register") {
        ws.send(
          JSON.stringify({
            ...registered,
            id: `c_${connection}`,
            ts: new Date().toISOString(),
            payload: {
              ...(registered.payload as object),
              connectionId: `conn_${connection}`,
            },
          }),
        );
      }
    });
  }

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return Object.assign(controller, { url: `http://127.0.0.1:${port}` });
}

/** A valid message fixture from protocol/twin/v1/conformance. */
export function fixture(name: string): Envelope {
  return JSON.parse(
    readFileSync(join(PROTOCOL, "conformance", "valid", "messages", name), "utf8"),
  ) as Envelope;
}

function loadValidator() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictTypes: false,
    strictRequired: false,
  });
  (addFormatsModule as unknown as (a: Ajv2020) => void)(ajv);
  for (const file of schemaFiles(join(PROTOCOL, "schema")))
    ajv.addSchema(JSON.parse(readFileSync(file, "utf8")));
  const validate = ajv.getSchema(MESSAGE_SCHEMA);
  if (!validate) throw new Error("message.schema.json did not load");
  return validate;
}

function schemaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return schemaFiles(path);
    return entry.name.endsWith(".schema.json") ? [path] : [];
  });
}
