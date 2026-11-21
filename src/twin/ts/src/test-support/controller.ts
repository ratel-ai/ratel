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
  /** Sockets open when the frame arrived: 2 during a make-before-break drain. */
  readonly openSockets: number;
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
  /** Sends run.start (the fixture, with this runId and payload changes). Returns the runId. */
  startRun(runId: string, payload?: Record<string, unknown>): string;
  /**
   * The run.event and run.end frames stored for a run, one per seq, in seq
   * order: what the gateway's twin_run_events table would hold.
   */
  stored(runId: string): Envelope[];
  /** Bodies of POST /api/v1/traces (OTLP JSON), with the bearer key they came with. */
  readonly traces: { key: string; body: OtlpTraces }[];
  /** Answers each run.event and run.end with events.ack while true. Default true. */
  autoAck: boolean;
  close(): Promise<void>;
}

/** The parts of an OTLP/JSON ExportTraceServiceRequest the tests read. */
export interface OtlpTraces {
  resourceSpans: {
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: { spans: { traceId: string; name: string; attributes: OtlpKeyValue[] }[] }[];
  }[];
}

export interface OtlpKeyValue {
  key: string;
  value: {
    stringValue?: string;
    boolValue?: boolean;
    intValue?: number | string;
    arrayValue?: { values: OtlpKeyValue["value"][] };
  };
}

export interface TestControllerOptions {
  /** Project keys the controller accepts. Default: any key. */
  readonly keys?: readonly string[];
  /** The port to listen on. Default: any free port. */
  readonly port?: number;
  /** Changes to the limits of the registered fixture (for short lease intervals in tests). */
  readonly limits?: Readonly<Record<string, number>>;
}

export async function startTestController(
  options: TestControllerOptions = {},
): Promise<TestController> {
  const validate = loadValidator();
  const registered = fixture("registered.json");
  const runStart = fixture("run.start.json");
  const storedEvents = new Map<string, Map<number, Envelope>>();
  let serverFrames = 0;
  const serverFrame = (type: string, payload: object, runId?: string): Envelope => ({
    v: 1,
    type,
    id: `c_${++serverFrames}`,
    ts: new Date().toISOString(),
    ...(runId ? { runId } : {}),
    payload,
  });
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
    startRun: (runId, payload = {}) => {
      controller.send({
        ...serverFrame("run.start", { ...(runStart.payload as object), ...payload }, runId),
      });
      return runId;
    },
    stored: (runId) =>
      [...(storedEvents.get(runId)?.entries() ?? [])].sort(([a], [b]) => a - b).map(([, f]) => f),
    autoAck: true,
    traces: [],
    close: async () => {
      for (const ws of open) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "POST" && req.url === "/api/v1/traces") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
        controller.traces.push({ key, body: JSON.parse(body) as OtlpTraces });
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      return;
    }
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
      const received = { connection, openSockets: open.size, token, raw, frame };
      controller.frames.push(received);
      for (const waiter of [...waiters]) {
        if (!waiter.match(received)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(received);
      }
      if ((frame.type === "run.event" || frame.type === "run.end") && frame.runId && frame.seq) {
        const events = storedEvents.get(frame.runId) ?? new Map<number, Envelope>();
        storedEvents.set(frame.runId, events);
        if (!events.has(frame.seq)) events.set(frame.seq, frame);
        if (controller.autoAck) {
          // The highest seq stored without a gap, as the gateway acks it.
          let seq = 0;
          while (events.has(seq + 1)) seq++;
          if (seq > 0) ws.send(JSON.stringify(serverFrame("events.ack", { seq }, frame.runId)));
        }
      }
      if (frame.type === "register") {
        const base = registered.payload as { limits: object };
        ws.send(
          JSON.stringify(
            serverFrame("registered", {
              ...base,
              connectionId: `conn_${connection}`,
              limits: { ...base.limits, ...options.limits },
            }),
          ),
        );
      }
    });
  }

  await new Promise<void>((resolve) => http.listen(options.port ?? 0, "127.0.0.1", resolve));
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
