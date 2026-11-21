import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { buildInfo } from "../cli/build-info.js";
import { discoverTwinFiles } from "../cli/discover.js";
import { canonicalJson } from "../hash.js";
import type { Manifest } from "../manifest.js";
import { ChildHost } from "./child-host.js";
import { ConnectError, exchangeToken, runnerSocketUrl } from "./connect-http.js";
import { Connection, type ConnectionEffect, type ConnectionEvent } from "./connection.js";
import { type Envelope, type FrameStamp, MAX_FRAME_BYTES, parseFrame } from "./protocol.js";
import { watchProject } from "./watch.js";
import { openSocket, type Socket } from "./ws-socket.js";

// `ratel dev`: the runtime around the pure Connection machine. It performs the
// machine's effects with real adapters (HTTP, websocket, timers, the child
// worker, the file watcher) and feeds their results back in as events.

export const DEFAULT_BASE_URL = "https://cloud.ratel.sh";

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
  /** Frames for the run layer (run.start, run.cancel, events.ack, drain). */
  readonly onFrame?: (frame: Envelope) => void;
}

export interface DevHandle {
  /** Settles when the runner stops: resolves on stop(), rejects on a fatal error. */
  readonly done: Promise<void>;
  stop(): void;
}

/** Loads the twins, connects to Ratel and keeps the connection alive until stop(). */
export async function startDev(options: DevOptions): Promise<DevHandle> {
  const child = new ChildHost(options.root);
  const manifest = await loadManifest(child, options.root);
  const connection = new Connection({
    runner: runnerInfo(options.root),
    manifest,
    stamp: frameStamp(),
    maxConcurrency: 1,
    random: options.random,
  });
  const sockets = new Map<number, Socket>();
  let projectId: string | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let stopWatching = () => {};
  let settle: { resolve(): void; reject(err: Error): void } | undefined;
  const done = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const step = (event: ConnectionEvent): void => {
    for (const effect of connection.step(event)) perform(effect);
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
        if (effect.reconnected) {
          options.out(`reconnected (${effect.connectionId})`);
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
        options.onFrame?.(effect.frame);
        return;
    }
  };

  const reload = async (): Promise<void> => {
    try {
      const next = await loadManifest(child, options.root);
      const changed = canonicalJson(next) !== canonicalJson(connection.manifest);
      options.out(`reloaded ${next.twins.length} twin(s)${changed ? "; manifest updated" : ""}`);
      if (changed) step({ type: "manifest.changed", manifest: next });
    } catch (err) {
      options.out(`reload failed: ${messageOf(err)}`);
    }
  };

  const shutdown = (): void => {
    stopWatching();
    clearTimeout(retryTimer);
    child.stop();
  };

  options.out(
    `ratel dev: ${manifest.twins.length} twin(s): ${manifest.twins.map((t) => t.id).join(", ") || "(none)"}`,
  );
  if (options.watch ?? true) stopWatching = watchProject(options.root, () => void reload());
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

/** One `<twin id>  <url>` line per twin. */
export function playgroundLines(
  baseUrl: string,
  projectId: string | undefined,
  manifest: Manifest,
): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  const prefix = projectId ? `${base}/project/${encodeURIComponent(projectId)}` : base;
  const width = Math.max(0, ...manifest.twins.map((t) => t.id.length));
  return manifest.twins.map((t) => `  ${t.id.padEnd(width)}  ${prefix}/twins/${t.id}`);
}

async function loadManifest(child: ChildHost, root: string): Promise<Manifest> {
  return child.restart(discoverTwinFiles(root), buildInfo(root));
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
