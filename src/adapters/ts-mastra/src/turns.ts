import type { MastraDBMessage } from "@mastra/core/agent";
import { GET_SKILL_CONTENT_ID, INVOKE_TOOL_ID, SEARCH_CAPABILITIES_ID } from "@ratel-ai/sdk";

/**
 * The turn surface of an adapted view. Optional because the adapter peers SDKs
 * older than the turn scope (ADR-0020's peer floor): on those, every method
 * here is absent and the adapter records exactly what it recorded before.
 */
export interface TurnCapableBase {
  turn?<T>(fn: () => T, options?: { id?: string; userMessage?: string }): T;
  currentTurnId?(): string | undefined;
  recordToolCall?(call: {
    toolId: string;
    tookMs?: number;
    error?: unknown;
    turnId?: string;
  }): void;
}

interface TurnEntry {
  readonly id: string;
  readonly base: TurnCapableBase;
}

// The model-facing tools whose calls the SDK already records through the
// capability funnel; observing them again from the transcript would double-count.
const CAPABILITY_TOOL_IDS: ReadonlySet<string> = new Set([
  SEARCH_CAPABILITIES_ID,
  INVOKE_TOOL_ID,
  GET_SKILL_CONTENT_ID,
]);

// Per-generation processor state key for the tool calls already recorded.
const RECORDED_STATE_KEY = "ratel.recordedToolCallIds";

/**
 * Opens one Ratel turn per Mastra generation and finds it again from inside
 * it. A generation's processors and tool executions share one `requestContext`
 * object (Mastra creates a fresh one per call unless the host passes its own),
 * so that object keys the turn. A host that wraps `agent.generate(...)` in
 * `r.turn(...)` needs no key: its scope already covers the generation and the
 * adapter joins it.
 */
export class MastraTurns {
  readonly #byRequestContext = new WeakMap<object, TurnEntry>();
  readonly #captureUserMessage: boolean;

  constructor(captureUserMessage: boolean) {
    this.#captureUserMessage = captureUserMessage;
  }

  /** Run one recall as the start of a turn: join the host's active turn, or open one. */
  async recall<T>(
    base: TurnCapableBase,
    requestContext: unknown,
    query: string,
    recall: () => Promise<T>,
  ): Promise<T> {
    if (typeof base.turn !== "function" || typeof base.currentTurnId !== "function") {
      return recall();
    }
    const currentTurnId = base.currentTurnId.bind(base);
    const index = (result: T): T => {
      const id = currentTurnId();
      if (id !== undefined && isObject(requestContext)) {
        this.#byRequestContext.set(requestContext, { id, base });
      }
      return result;
    };
    if (currentTurnId() !== undefined) return index(await recall());
    return base.turn(async () => index(await recall()), {
      ...(this.#captureUserMessage ? { userMessage: query } : {}),
    });
  }

  /** Run one tool execution inside the turn its generation belongs to, when one is known. */
  run<T>(requestContext: unknown, execute: () => T): T {
    const entry = isObject(requestContext) ? this.#byRequestContext.get(requestContext) : undefined;
    if (entry === undefined || entry.base.turn === undefined) return execute();
    if (entry.base.currentTurnId?.() !== undefined) return execute();
    return entry.base.turn(execute, { id: entry.id });
  }

  /**
   * Record the tool calls this generation has completed that the SDK did not
   * run: tools the Agent holds beside Ratel's. Mastra exposes them only through
   * the transcript at the start of the next step, so the last step's calls are
   * not seen, no duration is known, and a failed call is indistinguishable
   * from one that returned its error text, so every call records as completed.
   */
  observe(
    base: TurnCapableBase,
    args: {
      messages?: MastraDBMessage[];
      requestContext?: unknown;
      state?: Record<string, unknown>;
    },
  ): void {
    if (typeof base.recordToolCall !== "function" || !Array.isArray(args.messages)) return;
    const recorded = recordedIds(args.state);
    const turnId =
      base.currentTurnId?.() ??
      (isObject(args.requestContext)
        ? this.#byRequestContext.get(args.requestContext)?.id
        : undefined);
    for (const invocation of completedInvocationsThisTurn(args.messages)) {
      if (recorded.has(invocation.toolCallId)) continue;
      recorded.add(invocation.toolCallId);
      if (CAPABILITY_TOOL_IDS.has(invocation.toolName)) continue;
      base.recordToolCall({
        toolId: invocation.toolName,
        ...(turnId === undefined ? {} : { turnId }),
      });
    }
  }
}

function recordedIds(state: Record<string, unknown> | undefined): Set<string> {
  if (state === undefined) return new Set();
  const existing = state[RECORDED_STATE_KEY];
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  state[RECORDED_STATE_KEY] = created;
  return created;
}

interface ToolInvocationPart {
  type: "tool-invocation";
  toolInvocation: { state?: string; toolCallId?: unknown; toolName?: unknown };
}

// Only what follows the last user message: earlier tool calls belong to turns
// the conversation already finished.
function completedInvocationsThisTurn(
  messages: MastraDBMessage[],
): { toolCallId: string; toolName: string }[] {
  let lastUser = -1;
  messages.forEach((message, position) => {
    if (message?.role === "user") lastUser = position;
  });
  const out: { toolCallId: string; toolName: string }[] = [];
  for (const message of messages.slice(lastUser + 1)) {
    for (const part of message?.content?.parts ?? []) {
      if ((part as { type?: string }).type !== "tool-invocation") continue;
      const invocation = (part as ToolInvocationPart).toolInvocation;
      if (
        invocation?.state === "result" &&
        typeof invocation.toolCallId === "string" &&
        typeof invocation.toolName === "string"
      ) {
        out.push({ toolCallId: invocation.toolCallId, toolName: invocation.toolName });
      }
    }
  }
  return out;
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
