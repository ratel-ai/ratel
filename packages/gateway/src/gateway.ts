import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { isTerminalStatus } from "@/lib/views/sandboxes/domain/run";
import { type SandboxTokenClaims, verifySandboxToken } from "@/lib/views/sandboxes/domain/token";
import {
  type FakeRequest,
  GENERATION_FAILED_RESULT,
} from "@/lib/views/sandboxes/fakes/domain/fake";
import type { FakeService } from "@/lib/views/sandboxes/fakes/service";
import type {
  PendingCommand,
  SandboxGatewayStore,
} from "@/lib/views/sandboxes/ports/gateway-store";
import type { Logger } from "./logger";
import {
  DEFAULT_LIMITS,
  type Envelope,
  type FrameValidator,
  frame,
  type Limits,
  MAX_FRAME_BYTES,
} from "./protocol";

/**
 * The sandbox runner gateway (spec §8). It holds the `ratel sandbox dev` sockets of
 * runners and moves frames between them and the sandbox tables:
 *
 * - commands (`run.start`, `run.cancel`, …) are read from `sandbox_commands`
 *   after every wake-up, reconnect and poll tick, and forwarded to the socket
 *   of the run's runner; `run.start` is acked once the worker acks or rejects;
 * - `run.event` / `run.end` are stored once per (run, seq) and answered with
 *   `events.ack` carrying the highest seq stored with no gap;
 * - `run.lease` keeps a run alive; a sweep marks runs with no lease as lost;
 * - on drain, every runner is told to move (make-before-break) first;
 * - `tool.fake.request` is answered here, on the same socket, by the fake
 *   service (`lib/sandboxes/fakes`): a table round trip through the web app would
 *   add a wake-up per tool call. A run the service fails (over the daily cap)
 *   ends as `error` with the generic `run_failed`, and the worker gets `run.cancel`.
 *
 * A socket may only speak about runs of its own runner: a frame for another
 * project's, owner's or runner's run closes it.
 */

export interface GatewayOptions {
  gatewayId: string;
  store: SandboxGatewayStore;
  validator: FrameValidator;
  tokenSecret: string;
  logger: Logger;
  limits?: Partial<Limits>;
  now?: () => Date;
  /** How often unacked commands are re-read without a wake-up. NOTIFY can be lost. */
  pollIntervalMs?: number;
  lostSweepIntervalMs?: number;
  pingIntervalMs?: number;
  drainTimeoutMs?: number;
  /** Answers fake-mode tool calls. Without it, every fake call gets a tool error. */
  fakes?: FakeService;
}

export interface Gateway {
  readonly server: Server;
  /** Reads and forwards unacked commands. Safe to call often: runs are serialized. */
  wake(): void;
  listen(port: number, host?: string): Promise<number>;
  /** Sends `drain` to every runner, refuses new sockets and waits for them to move. */
  drain(reason: string): Promise<void>;
  close(): Promise<void>;
  connectionCount(): number;
}

interface Connection {
  id: string;
  ws: WebSocket;
  claims: SandboxTokenClaims;
  runnerId: string | null;
  /** Runs this socket may speak about, checked once against the store. */
  runs: Set<string>;
  alive: boolean;
}

interface PendingAck {
  commandId: string;
  connection: Connection;
  timer: NodeJS.Timeout;
}

const CLOSE_POLICY = 4003;
/** A fake result bigger than this does not fit one frame with its envelope. */
const MAX_FAKE_RESULT_BYTES = MAX_FRAME_BYTES - 4_096;
const CLOSE_TOO_BIG = 1009;

export function createGateway(options: GatewayOptions): Gateway {
  const { store, validator, logger, gatewayId } = options;
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? (() => new Date());
  const connections = new Map<string, Connection>();
  const byRunner = new Map<string, Connection>();
  const awaitingAck = new Map<string, PendingAck>();
  const eventQueues = new Map<
    string,
    { events: Envelope[]; connection: Connection; flushing: boolean }
  >();
  let draining = false;
  let pumping = false;
  let pumpAgain = false;

  const http = createServer((req, res) => handleHttp(req, res));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  http.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head));

  const timers = [
    setInterval(() => wake(), options.pollIntervalMs ?? 5_000),
    setInterval(() => void sweepLost(), options.lostSweepIntervalMs ?? 10_000),
    setInterval(() => pingAll(), options.pingIntervalMs ?? 30_000),
  ];
  for (const timer of timers) timer.unref();

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(draining ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: !draining, gatewayId, connections: connections.size }));
      return;
    }
    if (req.url?.startsWith("/runner")) {
      res.writeHead(426, { upgrade: "websocket" }).end();
      return;
    }
    res.writeHead(404).end();
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://gateway");
    if (url.pathname !== "/runner") return refuse(socket, 404, "Not Found");
    if (draining) return refuse(socket, 503, "Service Unavailable");
    const verified = verifySandboxToken(
      url.searchParams.get("token") ?? "",
      options.tokenSecret,
      now(),
    );
    if (!verified.ok) {
      logger.info({ reason: verified.reason }, "refused runner socket");
      return refuse(socket, 401, "Unauthorized");
    }
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, verified.claims));
  }

  function accept(ws: WebSocket, claims: SandboxTokenClaims): void {
    const connection: Connection = {
      id: `conn_${randomUUID().slice(0, 8)}`,
      ws,
      claims,
      runnerId: null,
      runs: new Set(),
      alive: true,
    };
    connections.set(connection.id, connection);
    logger.info(
      { connection_id: connection.id, project_id: claims.projectId },
      "accepted runner socket",
    );
    ws.on("pong", () => (connection.alive = true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return close(connection, CLOSE_POLICY, "binary frames are not supported");
      void onFrame(connection, data.toString()).catch((err: Error) =>
        logger.error(
          { err: { message: err.message }, connection_id: connection.id },
          "frame handling failed",
        ),
      );
    });
    ws.on("error", (err) =>
      logger.warn(
        { err: { message: err.message }, connection_id: connection.id },
        "runner socket failed",
      ),
    );
    ws.on("close", () => void onClose(connection));
  }

  async function onFrame(connection: Connection, raw: string): Promise<void> {
    if (Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES)
      return close(connection, CLOSE_TOO_BIG, "frame over 64 KB");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn({ connection_id: connection.id }, "dropped frame that is not json");
      return;
    }
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== "string" || !validator.knownTypes.has(type)) {
      logger.info(
        { connection_id: connection.id, type: String(type) },
        "dropped frame of unknown type",
      );
      return;
    }
    const invalid = validator.message(parsed);
    if (invalid) {
      logger.warn({ connection_id: connection.id, type, reason: invalid }, "dropped invalid frame");
      return;
    }
    const message = parsed as Envelope;
    if (message.type === "register") return onRegister(connection, message);
    if (!connection.runnerId) {
      logger.warn({ connection_id: connection.id, type }, "dropped frame before register");
      return;
    }
    if (message.type === "manifest.update") {
      await store.updateManifest(
        connection.runnerId,
        message.payload.manifest as Record<string, unknown>,
      );
      return;
    }
    if (!message.runId) return;
    if (!(await ownsRun(connection, message.runId))) return;
    switch (message.type) {
      case "run.ack":
        return onRunAck(message.runId);
      case "run.reject":
        return onRunReject(message.runId, message.payload);
      case "run.lease":
        return store.recordLease(message.runId, now());
      case "run.event":
      case "run.end":
        return enqueueEvent(connection, message);
      case "tool.fake.request":
        return onFakeRequest(connection, message);
      default:
        // tool.confirm.request: the playground answers it in a later task.
        logger.info(
          { connection_id: connection.id, type, run_id: message.runId },
          "dropped tool request",
        );
    }
  }

  async function onRegister(connection: Connection, message: Envelope): Promise<void> {
    const payload = message.payload as {
      runner: { instanceId: string };
      manifest: Record<string, unknown>;
      maxConcurrency?: number;
    };
    const { runnerId } = await store.registerRunner({
      projectId: connection.claims.projectId,
      ownerUserId: connection.claims.ownerUserId,
      instanceId: payload.runner.instanceId,
      gatewayId,
      connectionId: connection.id,
      manifest: payload.manifest,
      maxConcurrency: payload.maxConcurrency ?? 1,
    });
    connection.runnerId = runnerId;
    byRunner.set(runnerId, connection);
    send(
      connection,
      frame("registered", { connectionId: connection.id, limits: { ...limits } }, undefined, now()),
    );
    logger.info(
      {
        connection_id: connection.id,
        runner_id: runnerId,
        project_id: connection.claims.projectId,
      },
      "registered runner",
    );
    wake();
  }

  /** Whether the run is this socket's. A run of another project, owner or runner closes the socket. */
  async function ownsRun(connection: Connection, runId: string): Promise<boolean> {
    if (connection.runs.has(runId)) return true;
    const owner = /^[0-9a-f-]{36}$/i.test(runId) ? await store.runOwner(runId) : null;
    const mine =
      owner !== null &&
      owner.projectId === connection.claims.projectId &&
      owner.ownerUserId === connection.claims.ownerUserId &&
      owner.runnerId === connection.runnerId;
    if (!mine) {
      logger.warn(
        { connection_id: connection.id, run_id: runId },
        "closed socket that spoke about another runner's run",
      );
      close(connection, CLOSE_POLICY, "run does not belong to this runner");
      return false;
    }
    connection.runs.add(runId);
    return true;
  }

  async function onRunAck(runId: string): Promise<void> {
    await store.markRunAcked(runId, now());
    await settleStart(runId);
  }

  async function onRunReject(runId: string, payload: Record<string, unknown>): Promise<void> {
    await store.rejectRun(
      runId,
      String(payload.reason),
      typeof payload.message === "string" ? payload.message : undefined,
      now(),
    );
    await settleStart(runId);
  }

  async function settleStart(runId: string): Promise<void> {
    const pending = awaitingAck.get(runId);
    if (!pending) return;
    clearTimeout(pending.timer);
    awaitingAck.delete(runId);
    await store.ackCommand(pending.commandId);
  }

  async function onFakeRequest(connection: Connection, message: Envelope): Promise<void> {
    const runId = message.runId!;
    const payload = message.payload as Omit<FakeRequest, "runId">;
    const reply = (result: unknown, isError: boolean, source: string) =>
      send(
        connection,
        frame(
          "tool.fake.result",
          { callId: payload.callId, result, isError, source },
          runId,
          now(),
        ),
      );
    if (!options.fakes) {
      logger.warn(
        { run_id: runId, tool: payload.tool },
        "answered fake request without a fake service",
      );
      return reply(GENERATION_FAILED_RESULT, true, "generated");
    }
    let outcome;
    try {
      outcome = await options.fakes.answer({ ...payload, runId });
    } catch (err) {
      logger.error(
        { err: { message: (err as Error).message }, run_id: runId, tool: payload.tool },
        "fake request failed",
      );
      return reply(GENERATION_FAILED_RESULT, true, "generated");
    }
    if (outcome.kind === "fail_run") {
      await store.failRun(runId, outcome.error, now());
      send(connection, frame("run.cancel", { reason: outcome.error.code }, runId, now()));
      return;
    }
    const { result, isError, source } = outcome.answer;
    if (Buffer.byteLength(JSON.stringify(result) ?? "", "utf8") > MAX_FAKE_RESULT_BYTES) {
      logger.warn({ run_id: runId, tool: payload.tool, source }, "fake result over the frame size");
      return reply(GENERATION_FAILED_RESULT, true, source);
    }
    reply(result, isError, source);
  }

  function enqueueEvent(connection: Connection, message: Envelope): void {
    const runId = message.runId!;
    const queue = eventQueues.get(runId) ?? { events: [], connection, flushing: false };
    queue.events.push(message);
    queue.connection = connection;
    eventQueues.set(runId, queue);
    if (!queue.flushing) void flushEvents(runId);
  }

  /** Stores the queued events of a run in batches: one write and one ack per batch. */
  async function flushEvents(runId: string): Promise<void> {
    const queue = eventQueues.get(runId);
    if (!queue) return;
    queue.flushing = true;
    try {
      while (queue.events.length > 0) {
        const batch = queue.events.splice(0);
        const { ackedSeq } = await store.appendEvents(
          runId,
          batch.map((m) => ({
            seq: m.seq!,
            kind: m.type === "run.end" ? "run.end" : String(m.payload.kind),
            payload: m.payload,
          })),
        );
        if (ackedSeq > 0)
          send(queue.connection, frame("events.ack", { seq: ackedSeq }, runId, now()));
      }
    } catch (err) {
      // Unacked: the worker resends these after its next reconnect.
      logger.error(
        { err: { message: (err as Error).message }, run_id: runId },
        "event append failed",
      );
    } finally {
      queue.flushing = false;
      if (queue.events.length === 0) eventQueues.delete(runId);
    }
  }

  function wake(): void {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    void (async () => {
      do {
        pumpAgain = false;
        try {
          await pumpCommands();
        } catch (err) {
          logger.error({ err: { message: (err as Error).message } }, "command read failed");
        }
      } while (pumpAgain);
      pumping = false;
    })();
  }

  async function pumpCommands(): Promise<void> {
    for (const command of await store.pendingCommands(gatewayId)) {
      if (isTerminalStatus(command.runStatus)) {
        await store.ackCommand(command.id);
        continue;
      }
      const connection = command.runnerId ? byRunner.get(command.runnerId) : undefined;
      if (!connection || connection.ws.readyState !== WebSocket.OPEN) continue;
      await forward(connection, command);
    }
  }

  async function forward(connection: Connection, command: PendingCommand): Promise<void> {
    if (command.kind === "run.start" && awaitingAck.has(command.runId)) return;
    const outgoing = frame(command.kind, command.payload, command.runId, now());
    const invalid = validator.message(outgoing);
    if (invalid) {
      logger.error(
        { command_id: command.id, kind: command.kind, reason: invalid },
        "dropped invalid command",
      );
      await store.ackCommand(command.id);
      if (command.kind === "run.start")
        await store.rejectRun(
          command.runId,
          "invalid_command",
          "The run could not be sent to the runner.",
          now(),
        );
      return;
    }
    connection.runs.add(command.runId);
    send(connection, outgoing);
    if (command.kind !== "run.start") {
      await store.ackCommand(command.id);
      return;
    }
    const timer = setTimeout(() => void ackTimedOut(command.runId), limits.ackTimeoutMs);
    timer.unref();
    awaitingAck.set(command.runId, { commandId: command.id, connection, timer });
  }

  async function ackTimedOut(runId: string): Promise<void> {
    const pending = awaitingAck.get(runId);
    if (!pending) return;
    awaitingAck.delete(runId);
    // A socket that closed meanwhile gets the command again on its reconnect.
    if (pending.connection.ws.readyState !== WebSocket.OPEN) return;
    logger.warn({ run_id: runId }, "rejected run without ack");
    await store.rejectRun(
      runId,
      "ack_timeout",
      "The runner did not acknowledge the run in time.",
      now(),
    );
    await store.ackCommand(pending.commandId);
  }

  async function sweepLost(): Promise<void> {
    try {
      const lost = await store.markLost(now(), limits.leaseTimeoutMs);
      if (lost.length > 0) logger.warn({ runs: lost.length }, "marked runs lost");
    } catch (err) {
      logger.error({ err: { message: (err as Error).message } }, "lost sweep failed");
    }
  }

  function pingAll(): void {
    for (const connection of connections.values()) {
      if (!connection.alive) {
        connection.ws.terminate();
        continue;
      }
      connection.alive = false;
      connection.ws.ping();
    }
  }

  async function onClose(connection: Connection): Promise<void> {
    connections.delete(connection.id);
    for (const [runId, pending] of awaitingAck) {
      if (pending.connection !== connection) continue;
      clearTimeout(pending.timer);
      awaitingAck.delete(runId);
    }
    if (!connection.runnerId) return;
    if (byRunner.get(connection.runnerId) === connection) byRunner.delete(connection.runnerId);
    try {
      await store.disconnectRunner(connection.runnerId, connection.id);
    } catch (err) {
      logger.error(
        { err: { message: (err as Error).message }, runner_id: connection.runnerId },
        "runner disconnect failed",
      );
    }
    logger.info(
      { connection_id: connection.id, runner_id: connection.runnerId },
      "closed runner socket",
    );
  }

  function send(connection: Connection, message: Envelope): void {
    const invalid = validator.message(message);
    if (invalid) {
      logger.error({ type: message.type, reason: invalid }, "refused to send invalid frame");
      return;
    }
    if (connection.ws.readyState === WebSocket.OPEN) connection.ws.send(JSON.stringify(message));
  }

  function close(connection: Connection, code: number, reason: string): void {
    connection.ws.close(code, reason);
  }

  return {
    server: http,
    wake,
    connectionCount: () => connections.size,
    listen: (port, host) =>
      new Promise((resolve) => {
        http.listen(port, host, () => {
          const address = http.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      }),
    async drain(reason) {
      draining = true;
      const deadlineMs = options.drainTimeoutMs ?? 20_000;
      for (const connection of connections.values())
        send(connection, frame("drain", { reason, deadlineMs }, undefined, now()));
      const until = Date.now() + deadlineMs;
      while (connections.size > 0 && Date.now() < until)
        await new Promise((r) => setTimeout(r, 100));
    },
    async close() {
      for (const timer of timers) clearInterval(timer);
      for (const pending of awaitingAck.values()) clearTimeout(pending.timer);
      for (const connection of connections.values()) connection.ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
