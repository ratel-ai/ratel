import type { Manifest } from "../manifest.js";

// The twin/v1 wire shapes the worker speaks (protocol/twin/v1). Pure data: no
// socket, no clock. The caller supplies the frame ID and the time.

export const PROTOCOL_VERSION = 1;
/** The largest frame either side may send, in UTF-8 bytes. */
export const MAX_FRAME_BYTES = 65536;

export interface Envelope<T extends string = string, P extends object = object> {
  readonly v: typeof PROTOCOL_VERSION;
  readonly type: T;
  readonly id: string;
  readonly ts: string;
  readonly runId?: string;
  readonly seq?: number;
  readonly payload: P;
}

export interface RunnerInfo {
  /** Stable across restarts, unique per machine and project root. */
  readonly instanceId: string;
  readonly owner?: string;
  readonly host?: string;
}

export interface RegisterPayload {
  readonly runner: RunnerInfo;
  readonly capabilities: readonly string[];
  readonly maxConcurrency: number;
  readonly manifest: Manifest;
}

export interface Limits {
  readonly maxFrameBytes: number;
  readonly ackTimeoutMs: number;
  readonly leaseIntervalMs: number;
  readonly leaseTimeoutMs: number;
  readonly confirmTimeoutMs: number;
  readonly maxConcurrentRuns?: number;
}

export interface RegisteredPayload {
  readonly connectionId: string;
  readonly limits: Limits;
}

/** Makes the `id` and `ts` of each outgoing frame. Injected so the domain stays deterministic. */
export interface FrameStamp {
  nextId(): string;
  now(): Date;
}

/** Builds one outgoing frame. */
export function frame<T extends string, P extends object>(
  stamp: FrameStamp,
  type: T,
  payload: P,
  extra: { runId?: string; seq?: number } = {},
): Envelope<T, P> {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: stamp.nextId(),
    ts: stamp.now().toISOString(),
    ...(extra.runId !== undefined ? { runId: extra.runId } : {}),
    ...(extra.seq !== undefined ? { seq: extra.seq } : {}),
    payload,
  };
}

/**
 * Reads one incoming frame. Returns undefined for text that is not a twin/v1
 * envelope: the receiver drops it, as the protocol's compatibility rules say.
 */
export function parseFrame(text: string): Envelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<Envelope>;
  if (candidate.v !== PROTOCOL_VERSION) return undefined;
  if (typeof candidate.type !== "string" || typeof candidate.id !== "string") return undefined;
  if (typeof candidate.payload !== "object" || candidate.payload === null) return undefined;
  return candidate as Envelope;
}

export function isRegistered(f: Envelope): f is Envelope<"registered", RegisteredPayload> {
  const payload = f.payload as Partial<RegisteredPayload>;
  return (
    f.type === "registered" &&
    typeof payload.connectionId === "string" &&
    typeof payload.limits === "object" &&
    payload.limits !== null
  );
}
