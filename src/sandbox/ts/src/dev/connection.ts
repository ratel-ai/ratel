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

// The connection half of the sandbox/v1 worker as a pure state machine: it takes
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
      /** The replacement connection while a drain is in progress (make-before-break). */
      readonly next?: DrainStep;
    }
  | { readonly kind: "waiting"; readonly attempt: number }
  | { readonly kind: "stopped"; readonly reason: string };

export type DrainStep =
  | { readonly kind: "exchanging" }
  | { readonly kind: "opening" | "registering"; readonly socket: number };

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
      /** True when a drain moved the connection to a new socket without a gap. */
      readonly drained: boolean;
    }
  | { readonly type: "disconnected"; readonly reason: string; readonly retryInMs: number }
  | { readonly type: "fatal"; readonly message: string }
  /** Instance mode: the worker is done (drain, or the socket closed for good). Exit cleanly. */
  | { readonly type: "exit"; readonly reason: string }
  /** A frame for the run layer (run.start, run.cancel, events.ack, drain…). */
  | { readonly type: "frame"; readonly frame: Envelope };

/**
 * A hosted instance: it dials the gateway with the token it was started with
 * (no exchange), and ends on drain or when the socket stays closed.
 */
export interface InstanceGrant {
  readonly gatewayUrl: string;
  readonly token: string;
  readonly versionId: string;
  readonly sessionId?: string;
  /** Reconnect attempts after a close before the instance gives up. Default 5. */
  readonly maxReconnects?: number;
}

export const DEFAULT_MAX_RECONNECTS = 5;

export interface ConnectionOptions {
  readonly runner: RunnerInfo;
  /** Instance mode. Absent: dev mode, with a token exchange per connection. */
  readonly instance?: InstanceGrant;
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
        if (phase.kind === "ready" && phase.next?.kind === "exchanging") {
          const socket = this.#nextSocket++;
          this.#phase = { ...phase, next: { kind: "opening", socket } };
          return [{ type: "open-socket", socket, ...tokenOf(event) }];
        }
        if (phase.kind !== "exchanging") return [];
        return this.#open(phase.attempt, event.gatewayUrl, event.token);
      case "token.failed":
        if (phase.kind === "ready" && phase.next?.kind === "exchanging") {
          if (event.fatal) return this.#stop(event.message, phase.socket);
          // Stay on the old socket. When the gateway closes it, the normal reconnect runs.
          this.#phase = withoutNext(phase);
          return [];
        }
        if (phase.kind !== "exchanging") return [];
        if (event.fatal) return this.#stop(event.message);
        return this.#retry(phase.attempt, event.message);
      case "socket.open":
        if (phase.kind === "ready" && phase.next?.kind === "opening") {
          if (phase.next.socket !== event.socket) return [];
          this.#phase = { ...phase, next: { kind: "registering", socket: event.socket } };
          return [{ type: "send", socket: event.socket, frame: this.#register() }];
        }
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
        return this.#stop("stopped", currentSocket(phase), nextSocket(phase));
    }
  }

  #exchange(attempt: number): ConnectionEffect[] {
    const instance = this.#options.instance;
    if (instance) return this.#open(attempt, instance.gatewayUrl, instance.token);
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
    if (phase.kind === "ready" && nextSocket(phase) === socket) {
      // The replacement socket of a drain: switch over once it is registered.
      if (phase.next?.kind !== "registering" || !isRegistered(incoming)) return [];
      const { connectionId, limits } = incoming.payload;
      this.#phase = { kind: "ready", socket, connectionId, limits };
      return [
        { type: "close-socket", socket: phase.socket },
        { type: "registered", connectionId, limits, reconnected: true, drained: true },
      ];
    }
    if (currentSocket(phase) !== socket) return [];
    if (phase.kind === "registering") {
      if (!isRegistered(incoming)) return [];
      const { connectionId, limits } = incoming.payload;
      this.#phase = { kind: "ready", socket, connectionId, limits };
      const reconnected = this.#everRegistered;
      this.#everRegistered = true;
      return [{ type: "registered", connectionId, limits, reconnected, drained: false }];
    }
    if (phase.kind !== "ready") return [];
    if (incoming.type === "drain") {
      // An instance does not move: the provider stops its container.
      if (this.#options.instance) return this.#exit("drained", phase.socket);
      if (phase.next) return [];
      this.#phase = { ...phase, next: { kind: "exchanging" } };
      return [{ type: "exchange-token" }];
    }
    return [{ type: "frame", frame: incoming }];
  }

  #onClosed(socket: number, reason: string): ConnectionEffect[] {
    const phase = this.#phase;
    if (phase.kind === "ready" && phase.next) {
      if (nextSocket(phase) === socket) {
        // The replacement failed. Keep the old socket; its close starts a normal reconnect.
        this.#phase = withoutNext(phase);
        return [];
      }
      if (phase.socket === socket) {
        // The old socket went first: the replacement simply carries on.
        const next = phase.next;
        this.#phase =
          next.kind === "exchanging"
            ? { kind: "exchanging", attempt: 0 }
            : { kind: next.kind, attempt: 0, socket: next.socket };
        return [];
      }
    }
    if (currentSocket(phase) !== socket) return [];
    // A socket that reached ready earned a fresh start of the backoff.
    const attempt = phase.kind === "ready" ? 0 : (phase as { attempt: number }).attempt;
    return this.#retry(attempt, reason);
  }

  #retry(attempt: number, reason: string): ConnectionEffect[] {
    const instance = this.#options.instance;
    if (instance && attempt >= (instance.maxReconnects ?? DEFAULT_MAX_RECONNECTS))
      return this.#exit(`the connection closed for good (${reason})`);
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

  #stop(reason: string, ...sockets: (number | undefined)[]): ConnectionEffect[] {
    this.#phase = { kind: "stopped", reason };
    const effects: ConnectionEffect[] = sockets
      .filter((socket): socket is number => socket !== undefined)
      .map((socket) => ({ type: "close-socket", socket }));
    if (reason !== "stopped") effects.push({ type: "fatal", message: reason });
    return effects;
  }

  #exit(reason: string, ...sockets: number[]): ConnectionEffect[] {
    this.#phase = { kind: "stopped", reason };
    return [
      ...sockets.map((socket): ConnectionEffect => ({ type: "close-socket", socket })),
      { type: "exit", reason },
    ];
  }

  #register(): Envelope<"register", RegisterPayload> {
    const instance = this.#options.instance;
    return frame(this.#options.stamp, "register", {
      runner: this.#options.runner,
      capabilities: [...(this.#options.capabilities ?? [])],
      maxConcurrency: this.#options.maxConcurrency ?? 1,
      manifest: this.#manifest,
      ...(instance
        ? {
            role: "instance" as const,
            versionId: instance.versionId,
            ...(instance.sessionId ? { sessionId: instance.sessionId } : {}),
          }
        : {}),
    });
  }
}

function currentSocket(phase: ConnectionPhase): number | undefined {
  return "socket" in phase ? phase.socket : undefined;
}

function nextSocket(phase: ConnectionPhase): number | undefined {
  return phase.kind === "ready" && phase.next && "socket" in phase.next
    ? phase.next.socket
    : undefined;
}

function withoutNext(phase: Extract<ConnectionPhase, { kind: "ready" }>): ConnectionPhase {
  const { next: _next, ...rest } = phase;
  return rest;
}

function tokenOf(event: { gatewayUrl: string; token: string }) {
  return { gatewayUrl: event.gatewayUrl, token: event.token };
}
