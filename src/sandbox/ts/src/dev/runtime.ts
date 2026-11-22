import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { buildInfo } from "../cli/build-info.js";
import { discoverSandboxFiles } from "../cli/discover.js";
import { type Manifest, SDK_NAME, SDK_VERSION } from "../manifest.js";
import { ChildHost } from "./child-host.js";
import { ConnectError, exchangeToken, runnerSocketUrl } from "./connect-http.js";
import { Connection, type ConnectionEffect, type ConnectionEvent } from "./connection.js";
import { type Envelope, type FrameStamp, MAX_FRAME_BYTES, parseFrame } from "./protocol.js";
import { type RunStartPayload, Runs, type RunsEffect } from "./runs.js";
import { playgroundResource } from "./tracing.js";
import { POLL_INTERVAL_MS, type ProjectWatcher, watchProject } from "./watch.js";
import { openSocket, type Socket } from "./ws-socket.js";

// `ratel sandbox dev`: the runtime around the pure Connection machine. It performs the
// machine's effects with real adapters (HTTP, websocket, timers, the child
// worker, the file watcher) and feeds their results back in as events.

export const DEFAULT_BASE_URL = "https://cloud.ratel.sh";
/** Used until the controller states its own in `registered`. */
const DEFAULT_LEASE_INTERVAL_MS = 15_000;
/** One run at a time: a local runner serves one developer. */
const MAX_CONCURRENCY = 1;

export interface DevOptions {
  readonly root: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** One line of human output, without a newline. */
  readonly out: (line: string) => void;
  /** Reload on file changes. Default true. */
  readonly watch?: boolean;
  readonly fetch?: typeof fetch;
  readonly random?: () => number;
  /** Frames neither the connection nor the run layer handles (tool.* in a later version). */
  readonly onFrame?: (frame: Envelope) => void;
}

export interface DevHandle {
  /** Settles when the runner stops: resolves on stop(), rejects on a fatal error. */
  readonly done: Promise<void>;
  stop(): void;
}

/** Loads the sandboxes, connects to Ratel and keeps the connection alive until stop(). */
export async function startDev(options: DevOptions): Promise<DevHandle> {
  const child = new ChildHost(options.root);
  const runner = runnerInfo(options.root);
  const loadManifest = (): Promise<Manifest> => {
    const files = discoverSandboxFiles(options.root);
    const build = buildInfo(options.root, files);
    const resource = playgroundResource({
      build,
      runner,
      sdk: { name: SDK_NAME, version: SDK_VERSION },
    });
    return child.restart(files, build, {
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      resource,
    });
  };
  const manifest = await loadManifest();
  const stamp = frameStamp();
  const connection = new Connection({
    runner,
    manifest,
    stamp,
    maxConcurrency: MAX_CONCURRENCY,
    random: options.random,
  });
  const runs = new Runs({ stamp, maxConcurrency: MAX_CONCURRENCY });
  const sockets = new Map<number, Socket>();
  let projectId: string | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let leaseTimer: NodeJS.Timeout | undefined;
  let reloadWaiting = false;
  let watcher: ProjectWatcher | undefined;
  let settle: { resolve(): void; reject(err: Error): void } | undefined;
  const done = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const step = (event: ConnectionEvent): void => {
    for (const effect of connection.step(event)) perform(effect);
  };

  /** Sends on the live socket. While there is none, event frames wait in Runs for the resend. */
  const sendLive = (frame: Envelope): void => {
    const phase = connection.phase;
    if (phase.kind === "ready") perform({ type: "send", socket: phase.socket, frame });
  };

  const apply = (effects: RunsEffect[]): void => {
    for (const effect of effects) {
      switch (effect.type) {
        case "send":
          sendLive(effect.frame);
          break;
        case "execute":
          execute(effect.runId, effect.start);
          break;
        case "abort":
          child.cancel(effect.runId, effect.reason);
          break;
        case "tool-answer":
          child.answer(effect.runId, effect.answerType, effect.payload);
          break;
      }
    }
  };

  const execute = (runId: string, start: RunStartPayload): void => {
    const startedAt = Date.now();
    options.out(`run ${runId}: ${start.sandboxId} started`);
    child.run(runId, start, {
      onEvent: (payload) => apply(runs.event(runId, payload)),
      onToolRequest: (type, payload) => apply(runs.toolRequest(runId, type, payload)),
      onEnd: (result) => {
        apply(runs.end(runId, result));
        options.out(`run ${runId}: ${result.status} in ${Date.now() - startedAt} ms`);
        if (reloadWaiting && runs.active === 0) {
          reloadWaiting = false;
          void reload();
        }
      },
    });
  };

  const onRunFrame = (frame: Envelope): void => {
    const runId = frame.runId;
    switch (frame.type) {
      case "run.start":
        apply(runs.start(frame, connection.manifest, new Date()));
        return;
      case "run.cancel":
        if (runId) apply(runs.cancel(runId, (frame.payload as { reason?: string }).reason));
        return;
      case "tool.fake.result":
      case "tool.confirm.decision":
        apply(runs.toolAnswer(frame));
        return;
      case "events.ack": {
        const seq = (frame.payload as { seq?: unknown }).seq;
        if (runId && typeof seq === "number") runs.ack(runId, seq);
        return;
      }
      default:
        options.onFrame?.(frame);
    }
  };

  const startLeases = (intervalMs: number): void => {
    clearInterval(leaseTimer);
    leaseTimer = setInterval(() => apply(runs.lease(new Date())), intervalMs);
  };

  const perform = (effect: ConnectionEffect): void => {
    switch (effect.type) {
      case "exchange-token":
        exchangeToken({ baseUrl: options.baseUrl, apiKey: options.apiKey, fetch: options.fetch })
          .then((grant) => {
            projectId = grant.projectId ?? projectId;
            step({ type: "token.ok", gatewayUrl: grant.gatewayUrl, token: grant.token });
          })
          .catch((err: unknown) => {
            const fatal = err instanceof ConnectError && err.fatal;
            step({ type: "token.failed", message: messageOf(err), fatal });
          });
        return;
      case "open-socket": {
        const { socket } = effect;
        const url = runnerSocketUrl(effect.gatewayUrl, effect.token);
        sockets.set(
          socket,
          openSocket(url, {
            onOpen: () => step({ type: "socket.open", socket }),
            onText: (text) => {
              const frame = parseFrame(text);
              if (frame) step({ type: "socket.frame", socket, frame });
            },
            onClose: (reason) => {
              sockets.delete(socket);
              step({ type: "socket.closed", socket, reason });
            },
          }),
        );
        return;
      }
      case "send": {
        const text = JSON.stringify(effect.frame);
        if (Buffer.byteLength(text) > MAX_FRAME_BYTES) {
          options.out(`warning: ${effect.frame.type} is over ${MAX_FRAME_BYTES} bytes; not sent`);
          return;
        }
        sockets.get(effect.socket)?.send(text);
        return;
      }
      case "close-socket":
        sockets.get(effect.socket)?.close();
        sockets.delete(effect.socket);
        return;
      case "schedule-retry":
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => step({ type: "retry.due" }), effect.delayMs);
        return;
      case "registered":
        startLeases(effect.limits.leaseIntervalMs || DEFAULT_LEASE_INTERVAL_MS);
        // A new socket gets every event the controller has not acked, in seq order.
        for (const frame of runs.unacked()) sendLive(frame);
        if (effect.reconnected) {
          options.out(
            `${effect.drained ? "moved to a new gateway" : "reconnected"} (${effect.connectionId})`,
          );
        } else {
          options.out(`connected (${effect.connectionId})`);
          for (const line of playgroundLines(options.baseUrl, projectId, connection.manifest))
            options.out(line);
        }
        return;
      case "disconnected":
        options.out(
          `connection lost (${effect.reason}); reconnecting in ${(effect.retryInMs / 1000).toFixed(1)} s`,
        );
        return;
      case "fatal":
        shutdown();
        settle?.reject(new Error(effect.message));
        return;
      case "frame":
        onRunFrame(effect.frame);
        return;
    }
  };

  const reload = async (): Promise<void> => {
    if (runs.active > 0) {
      // A restart would kill the live run. Reload when it ends.
      if (!reloadWaiting) options.out("change seen; reloading after the live run");
      reloadWaiting = true;
      return;
    }
    try {
      const next = await loadManifest();
      // Always: the controller must learn of every reload, also one that only changed code.
      options.out(`reloaded ${next.sandboxes.length} sandbox(s); manifest updated`);
      step({ type: "manifest.changed", manifest: next });
      // A new sandbox file or import can add a folder to watch.
      watcher?.refresh();
    } catch (err) {
      options.out(`reload failed, still serving the last good code: ${messageOf(err)}`);
    }
  };

  const shutdown = (): void => {
    watcher?.close();
    clearTimeout(retryTimer);
    clearInterval(leaseTimer);
    child.stop();
  };

  options.out(
    `ratel sandbox dev: ${manifest.sandboxes.length} sandbox(s): ${manifest.sandboxes.map((t) => t.id).join(", ") || "(none)"}`,
  );
  if (options.watch ?? true)
    watcher = watchProject(options.root, {
      onChange: () => void reload(),
      onPolling: (reason, files) =>
        options.out(
          `hot reload now polls ${files} file(s) every ${POLL_INTERVAL_MS / 1000} s (file watcher unavailable: ${reason})`,
        ),
      onError: (message) =>
        options.out(
          `hot reload is off: the file watcher and polling failed (${message}). Still serving the last good code; restart ratel sandbox dev to reload`,
        ),
    });
  step({ type: "start" });

  return {
    done,
    stop: () => {
      step({ type: "stop" });
      shutdown();
      settle?.resolve();
    },
  };
}

/** One `<sandbox id>  <url>` line per sandbox. */
export function playgroundLines(
  baseUrl: string,
  projectId: string | undefined,
  manifest: Manifest,
): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  const prefix = projectId ? `${base}/project/${encodeURIComponent(projectId)}` : base;
  const width = Math.max(0, ...manifest.sandboxes.map((t) => t.id.length));
  return manifest.sandboxes.map((t) => `  ${t.id.padEnd(width)}  ${prefix}/sandboxes/${t.id}`);
}

/** Stable across restarts of the same project on the same machine. */
function runnerInfo(root: string): { instanceId: string; host: string } {
  const host = hostname();
  const digest = createHash("sha256").update(`${host}\0${root}`).digest("hex");
  return { instanceId: `rnr_${digest.slice(0, 16)}`, host };
}

function frameStamp(): FrameStamp {
  const prefix = randomUUID().slice(0, 8);
  let n = 0;
  return { nextId: () => `w_${prefix}_${++n}`, now: () => new Date() };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
