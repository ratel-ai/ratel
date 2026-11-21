import type { Manifest } from "../manifest.js";
import { backoffDelay } from "./backoff.js";
import {
  type Envelope,
  type FrameStamp,
  frame,
  isRegistered,
  type Limits,
  type RegisterPayload,
  type RunnerInfo,
} from "./protocol.js";

// The connection half of the twin/v1 worker as a pure state machine: it takes
// one event at a time and answers with the effects the runtime must perform.
// It does no I/O and reads no clock, so every path is testable without a socket.

export type ConnectionPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "exchanging"; readonly attempt: number }
  | { readonly kind: "opening"; readonly attempt: number; readonly socket: number }
  | { readonly kind: "registering"; readonly attempt: number; readonly socket: number }
  | {
      readonly kind: "ready";
      readonly socket: number;
      readonly connectionId: string;
      readonly limits: Limits;
    }
  | { readonly kind: "waiting"; readonly attempt: number }
  | { readonly kind: "stopped"; readonly reason: string };

export type ConnectionEvent =
  | { readonly type: "start" }
  | { readonly type: "token.ok"; readonly gatewayUrl: string; readonly token: string }
  | { readonly type: "token.failed"; readonly message: string; readonly fatal: boolean }
  | { readonly type: "socket.open"; readonly socket: number }
  | { readonly type: "socket.frame"; readonly socket: number; readonly frame: Envelope }
  | { readonly type: "socket.closed"; readonly socket: number; readonly reason: string }
  | { readonly type: "manifest.changed"; readonly manifest: Manifest }
  | { readonly type: "retry.due" }
  | { readonly type: "stop" };

export type ConnectionEffect =
  /** POST /api/v1/runner/connect for a fresh gateway URL and token. */
  | { readonly type: "exchange-token" }
  | {
      readonly type: "open-socket";
      readonly socket: number;
      readonly gatewayUrl: string;
      readonly token: string;
    }
  | { readonly type: "send"; readonly socket: number; readonly frame: Envelope }
  | { readonly type: "close-socket"; readonly socket: number }
  | { readonly type: "schedule-retry"; readonly delayMs: number }
  | {
      readonly type: "registered";
      readonly connectionId: string;
      readonly limits: Limits;
      readonly reconnected: boolean;
    }
  | { readonly type: "disconnected"; readonly reason: string; readonly retryInMs: number }
  | { readonly type: "fatal"; readonly message: string }
  /** A frame for the run layer (run.start, run.cancel, events.ack, drain…). */
  | { readonly type: "frame"; readonly frame: Envelope };

export interface ConnectionOptions {
  readonly runner: RunnerInfo;
  readonly manifest: Manifest;
  readonly stamp: FrameStamp;
  readonly capabilities?: readonly string[];
  readonly maxConcurrency?: number;
  readonly random?: () => number;
}

export class Connection {
  #phase: ConnectionPhase = { kind: "idle" };
  #manifest: Manifest;
  #nextSocket = 1;
  #everRegistered = false;
  readonly #options: ConnectionOptions;

  constructor(options: ConnectionOptions) {
    this.#options = options;
    this.#manifest = options.manifest;
  }

  get phase(): ConnectionPhase {
    return this.#phase;
  }

  get manifest(): Manifest {
    return this.#manifest;
  }

  /** Applies one event and returns the effects to perform, in order. */
  step(event: ConnectionEvent): ConnectionEffect[] {
    const phase = this.#phase;
    if (phase.kind === "stopped") return [];
    switch (event.type) {
      case "start":
        if (phase.kind !== "idle") return [];
        return this.#exchange(0);
      case "retry.due":
        if (phase.kind !== "waiting") return [];
        return this.#exchange(phase.attempt);
      case "token.ok":
        if (phase.kind !== "exchanging") return [];
        return this.#open(phase.attempt, event.gatewayUrl, event.token);
      case "token.failed":
        if (phase.kind !== "exchanging") return [];
        if (event.fatal) return this.#stop(event.message);
        return this.#retry(phase.attempt, event.message);
      case "socket.open":
        if (phase.kind !== "opening" || phase.socket !== event.socket) return [];
        this.#phase = { kind: "registering", attempt: phase.attempt, socket: event.socket };
        return [{ type: "send", socket: event.socket, frame: this.#register() }];
      case "socket.frame":
        return this.#onFrame(event.socket, event.frame);
      case "socket.closed":
        return this.#onClosed(event.socket, event.reason);
      case "manifest.changed":
        return this.#onManifest(event.manifest);
      case "stop":
        return this.#stop("stopped", currentSocket(phase));
    }
  }

  #exchange(attempt: number): ConnectionEffect[] {
    this.#phase = { kind: "exchanging", attempt };
    return [{ type: "exchange-token" }];
  }

  #open(attempt: number, gatewayUrl: string, token: string): ConnectionEffect[] {
    const socket = this.#nextSocket++;
    this.#phase = { kind: "opening", attempt, socket };
    return [{ type: "open-socket", socket, gatewayUrl, token }];
  }

  #onFrame(socket: number, incoming: Envelope): ConnectionEffect[] {
    const phase = this.#phase;
    if (currentSocket(phase) !== socket) return [];
    if (phase.kind === "registering") {
      if (!isRegistered(incoming)) return [];
      const { connectionId, limits } = incoming.payload;
      this.#phase = { kind: "ready", socket, connectionId, limits };
      const reconnected = this.#everRegistered;
      this.#everRegistered = true;
      return [{ type: "registered", connectionId, limits, reconnected }];
    }
    if (phase.kind === "ready") return [{ type: "frame", frame: incoming }];
    return [];
  }

  #onClosed(socket: number, reason: string): ConnectionEffect[] {
    const phase = this.#phase;
    if (currentSocket(phase) !== socket) return [];
    // A socket that reached ready earned a fresh start of the backoff.
    const attempt = phase.kind === "ready" ? 0 : (phase as { attempt: number }).attempt;
    return this.#retry(attempt, reason);
  }

  #retry(attempt: number, reason: string): ConnectionEffect[] {
    const delayMs = backoffDelay(attempt, this.#options.random);
    this.#phase = { kind: "waiting", attempt: attempt + 1 };
    return [
      { type: "disconnected", reason, retryInMs: delayMs },
      { type: "schedule-retry", delayMs },
    ];
  }

  #onManifest(manifest: Manifest): ConnectionEffect[] {
    this.#manifest = manifest;
    const phase = this.#phase;
    // Before registered, the next register carries the new manifest.
    if (phase.kind !== "ready") return [];
    const update = frame(this.#options.stamp, "manifest.update", { manifest });
    return [{ type: "send", socket: phase.socket, frame: update }];
  }

  #stop(reason: string, socket?: number): ConnectionEffect[] {
    this.#phase = { kind: "stopped", reason };
    const effects: ConnectionEffect[] =
      socket !== undefined ? [{ type: "close-socket", socket }] : [];
    if (reason !== "stopped") effects.push({ type: "fatal", message: reason });
    return effects;
  }

  #register(): Envelope<"register", RegisterPayload> {
    return frame(this.#options.stamp, "register", {
      runner: this.#options.runner,
      capabilities: [...(this.#options.capabilities ?? [])],
      maxConcurrency: this.#options.maxConcurrency ?? 1,
      manifest: this.#manifest,
    });
  }
}

function currentSocket(phase: ConnectionPhase): number | undefined {
  return "socket" in phase ? phase.socket : undefined;
}
