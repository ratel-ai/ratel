import type { ToolCatalog } from "./catalog.js";
import { newRuntimeEventId } from "./runtime-events.js";
import { ambientProjection } from "./telemetry.js";
import {
  activeTurn,
  type ExternalToolCall,
  externalErrorMessage,
  markExternalInvocation,
  resolveTurn,
  runInTurn,
  type TurnOptions,
  truncateUserMessage,
} from "./turn.js";

// A turn starts once: reopening a known id (a resumed stream, an adapter joining
// the host's turn) must not emit a second `turn_start`. Bounded per catalog.
const STARTED_TURNS_MAX = 4_096;
const startedTurns = new WeakMap<ToolCatalog, Set<string>>();

// A claim is released when recording fails, so a retry of the same id still
// opens the turn rather than being suppressed as already started.
function releaseTurnStart(catalog: ToolCatalog, turnId: string): void {
  startedTurns.get(catalog)?.delete(turnId);
}

function claimTurnStart(catalog: ToolCatalog, turnId: string): boolean {
  let started = startedTurns.get(catalog);
  if (started === undefined) {
    started = new Set();
    startedTurns.set(catalog, started);
  }
  if (started.has(turnId)) return false;
  started.add(turnId);
  if (started.size > STARTED_TURNS_MAX) {
    const oldest = started.values().next().value;
    if (oldest !== undefined) started.delete(oldest);
  }
  return true;
}

/**
 * @internal Run `fn` as one turn on `catalog`: everything it does inherits the
 * turn's id (and end-user id), and a `turn_start` event opens it once.
 */
export function runTurn<T>(catalog: ToolCatalog, fn: () => T, options: TurnOptions = {}): T {
  if (typeof fn !== "function") {
    throw new TypeError("ratel: turn() expects a function to run inside the turn");
  }
  if (options.userMessage !== undefined && typeof options.userMessage !== "string") {
    throw new TypeError("ratel: userMessage must be a string");
  }
  const outer = activeTurn();
  const turn = resolveTurn({
    ...options,
    endUserId: options.endUserId ?? outer?.endUserId,
  });
  return runInTurn(turn, () => {
    if (claimTurnStart(catalog, turn.id)) {
      try {
        catalog.recordEvent(
          {
            type: "turn_start",
            ...(options.userMessage === undefined
              ? {}
              : { user_message: truncateUserMessage(options.userMessage) }),
          },
          ambientProjection(),
        );
      } catch (error) {
        releaseTurnStart(catalog, turn.id);
        throw error;
      }
    }
    return fn();
  });
}

/**
 * @internal Record a tool the host's framework ran itself as one invocation
 * lifecycle (`invoke_start` then `invoke_end` or `invoke_error`), marked
 * `origin: "external"` on the runtime-event stream.
 */
export function recordExternalToolCall(catalog: ToolCatalog, call: ExternalToolCall): void {
  if (call === null || typeof call !== "object") {
    throw new TypeError("ratel: recordToolCall() expects { toolId, tookMs?, error?, turnId? }");
  }
  const { toolId, tookMs, turnId } = call;
  if (typeof toolId !== "string" || toolId.length === 0) {
    throw new TypeError("ratel: recordToolCall() needs a non-empty string toolId");
  }
  if (
    tookMs !== undefined &&
    (typeof tookMs !== "number" || !Number.isFinite(tookMs) || tookMs < 0)
  ) {
    throw new TypeError("ratel: tookMs must be a finite, non-negative number of milliseconds");
  }
  if (turnId !== undefined && (typeof turnId !== "string" || turnId.length === 0)) {
    throw new TypeError("ratel: turnId must be a non-empty string");
  }
  const invocationId = newRuntimeEventId();
  markExternalInvocation(invocationId);
  const projection = ambientProjection({ invocationId, turnId });
  const tookMsValue = Math.round(tookMs ?? 0);
  // The start is what adaptive ranking pairs with the turn's search (ADR-0014):
  // the agent chose this tool, whoever ran it.
  catalog.recordEvent({ type: "invoke_start", tool_id: toolId, args_size_bytes: 0 }, projection);
  catalog.recordEvent(
    "error" in call && call.error !== undefined
      ? {
          type: "invoke_error",
          tool_id: toolId,
          took_ms: tookMsValue,
          error: externalErrorMessage(call.error),
        }
      : { type: "invoke_end", tool_id: toolId, took_ms: tookMsValue },
    { ...projection, eventId: newRuntimeEventId() },
  );
}
