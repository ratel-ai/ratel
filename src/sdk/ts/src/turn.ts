import { AsyncLocalStorage } from "node:async_hooks";
// runtime-events.ts imports this module too. The cycle is safe because neither
// side touches the other at module top level, only inside function bodies.
import { newRuntimeEventId } from "./runtime-events.js";
import type { RuntimeEventProjection } from "./telemetry.js";

/** Maximum UTF-8 byte size of a `turn_start` event's `user_message`. */
export const TURN_USER_MESSAGE_MAX_BYTES = 4 * 1_024;

/** Options for one turn scope: see {@link Ratel.turn}. */
export interface TurnOptions {
  /**
   * Id for this turn, e.g. your request or message id. Defaults to a fresh
   * ULID. Reusing an id that already started joins that turn without a second
   * `turn_start`.
   */
  id?: string;
  /**
   * What the end user asked. Sent on the `turn_start` event only when you pass
   * it: passing it is the consent. Capped at 4 KiB of UTF-8.
   */
  userMessage?: string;
  /** Your pseudonymous id for the end user, stamped on every event in the turn. */
  endUserId?: string;
}

/** An external tool call for {@link Ratel.recordToolCall}: a tool your framework ran itself. */
export interface ExternalToolCall {
  /** Id (name) of the tool that ran. */
  toolId: string;
  /** Wall time in milliseconds. Defaults to `0` when unknown. */
  tookMs?: number;
  /**
   * Set when the call failed: an `Error`, or a message. Any other value is
   * stringified. Absent means the call succeeded.
   */
  error?: unknown;
  /** Turn to record it in. Defaults to the current turn scope, if any. */
  turnId?: string;
}

/** @internal The state one turn scope carries through async work. */
export interface ActiveTurn {
  readonly id: string;
  readonly endUserId?: string;
}

const turnStorage = new AsyncLocalStorage<ActiveTurn>();

/**
 * The id of the turn the caller is running inside, or `undefined` outside any
 * turn scope. Turn scopes nest: the innermost wins.
 */
export function currentTurnId(): string | undefined {
  return turnStorage.getStore()?.id;
}

/** @internal The innermost active turn, with its end-user id. */
export function activeTurn(): ActiveTurn | undefined {
  return turnStorage.getStore();
}

/** @internal Run `fn` with `turn` as the innermost turn scope. */
export function runInTurn<T>(turn: ActiveTurn, fn: () => T): T {
  return turnStorage.run(turn, fn);
}

/** @internal Resolve the turn a new scope opens: the caller's id or a fresh ULID. */
export function resolveTurn(options: TurnOptions = {}): ActiveTurn {
  const id = options.id ?? newRuntimeEventId();
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("ratel: turn id must be a non-empty string");
  }
  if (options.endUserId !== undefined && typeof options.endUserId !== "string") {
    throw new TypeError("ratel: endUserId must be a string");
  }
  return options.endUserId === undefined ? { id } : { id, endUserId: options.endUserId };
}

/**
 * @internal Fill the active turn's ids into an event's correlation context. An
 * explicit `turnId` already on the projection wins; the scope still supplies
 * the end-user id. Returns the input unchanged outside any turn scope.
 */
export function withTurnContext(
  projection: RuntimeEventProjection | undefined,
): RuntimeEventProjection | undefined {
  const turn = turnStorage.getStore();
  if (turn === undefined) return projection;
  const turnId = projection?.turnId ?? turn.id;
  const endUserId = projection?.endUserId ?? turn.endUserId;
  return {
    ...(projection ?? {}),
    turnId,
    ...(endUserId === undefined ? {} : { endUserId }),
  } as RuntimeEventProjection;
}

/** @internal Cap a user message at {@link TURN_USER_MESSAGE_MAX_BYTES} without splitting a character. */
export function truncateUserMessage(message: string): string {
  if (Buffer.byteLength(message, "utf8") <= TURN_USER_MESSAGE_MAX_BYTES) return message;
  let result = Buffer.from(message, "utf8")
    .subarray(0, TURN_USER_MESSAGE_MAX_BYTES)
    .toString("utf8");
  while (Buffer.byteLength(result, "utf8") > TURN_USER_MESSAGE_MAX_BYTES) {
    result = result.slice(0, -1);
  }
  // A cut through a multi-byte sequence decodes to U+FFFD; drop it.
  return result.replace(/�$/u, "");
}

/** @internal Message text for an `invoke_error` event. */
export function externalErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

const EXTERNAL_INVOCATIONS_MAX = 4_096;
const externalInvocations = new Set<string>();

/**
 * @internal Remember that an invocation id belongs to a tool the host ran
 * itself, so the runtime-events layer can stamp `origin: "external"` on its
 * lifecycle events. Core trace events have no `origin` field on invocations,
 * so the stamp is added where events leave the SDK. Bounded, oldest first out.
 */
export function markExternalInvocation(invocationId: string): void {
  externalInvocations.add(invocationId);
  if (externalInvocations.size > EXTERNAL_INVOCATIONS_MAX) {
    const oldest = externalInvocations.values().next().value;
    if (oldest !== undefined) externalInvocations.delete(oldest);
  }
}

/** @internal Whether an invocation id was recorded through `recordToolCall`. */
export function isExternalInvocation(invocationId: unknown): boolean {
  return typeof invocationId === "string" && externalInvocations.has(invocationId);
}
