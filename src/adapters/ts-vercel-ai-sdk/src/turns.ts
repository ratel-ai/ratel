import { GET_SKILL_CONTENT_ID, INVOKE_TOOL_ID, SEARCH_CAPABILITIES_ID } from "@ratel-ai/sdk";
import type { ModelMessage } from "ai";

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
// capability funnel; observing them again from a step would double-count.
const CAPABILITY_TOOL_IDS: ReadonlySet<string> = new Set([
  SEARCH_CAPABILITIES_ID,
  INVOKE_TOOL_ID,
  GET_SKILL_CONTENT_ID,
]);

const MAX_TRACKED_TURNS = 1_024;

/**
 * Opens one Ratel turn per AI SDK agent call and finds it again from inside
 * the call. The AI SDK hands the adapter no context of its own across a
 * `generateText`/`streamText` run, and an AsyncLocalStorage scope opened inside
 * `prepareStep` does not survive the run's later steps, so the turn is keyed by
 * what every tool execution can see: its prompt messages. The recall pair's
 * call id (unique per core) is the exact key; the last user message (its text
 * and how many user messages precede it) is the fallback when recall found
 * nothing. A host that wraps the call in `r.turn(...)` needs neither: its scope
 * already covers the whole run and the adapter joins it.
 */
export class AiSdkTurns {
  readonly #byRecallId = new Map<string, TurnEntry>();
  readonly #byUserMessage = new Map<string, TurnEntry>();
  readonly #byRun = new WeakMap<readonly unknown[], TurnEntry>();
  readonly #captureUserMessage: boolean;
  /** Passthrough ids whose executions the SDK records through its own funnel. */
  readonly recordedPassthroughIds = new Set<string>();

  constructor(captureUserMessage: boolean) {
    this.#captureUserMessage = captureUserMessage;
  }

  /**
   * Run one recall as the start of a turn: join the host's active turn, or
   * open a new one. Indexes the turn under the recall pair and the user
   * message so the run's tool executions find it.
   */
  async recall(
    base: TurnCapableBase,
    messages: readonly ModelMessage[],
    query: string,
    recall: () => Promise<ModelMessage[]>,
    run?: readonly unknown[],
  ): Promise<ModelMessage[]> {
    if (typeof base.turn !== "function" || typeof base.currentTurnId !== "function") {
      return recall();
    }
    const currentTurnId = base.currentTurnId.bind(base);
    const index = (pair: ModelMessage[]): ModelMessage[] => {
      const id = currentTurnId();
      if (id === undefined) return pair;
      const entry: TurnEntry = { id, base };
      const recallId = recallCallId(pair);
      if (recallId !== undefined) remember(this.#byRecallId, recallId, entry);
      const key = userMessageKey(messages);
      if (key !== undefined) remember(this.#byUserMessage, key, entry);
      if (run !== undefined) this.#byRun.set(run, entry);
      return pair;
    };
    if (currentTurnId() !== undefined) return index(await recall());
    return base.turn(async () => index(await recall()), {
      ...(this.#captureUserMessage ? { userMessage: query } : {}),
    });
  }

  /** Run one tool execution inside the turn its prompt belongs to, when one is known. */
  run<T>(messages: unknown, execute: () => T): T {
    const entry = this.#find(messages);
    if (entry === undefined || entry.base.turn === undefined) return execute();
    if (entry.base.currentTurnId?.() !== undefined) return execute();
    return entry.base.turn(execute, { id: entry.id });
  }

  /**
   * Record the tool calls of a finished step that the SDK did not run: host
   * tools passed to the model beside Ratel's, and provider-executed tools. A
   * step's calls are visible only from the next step's `prepareStep`, so the
   * last step of a run is never observed, and no duration is known.
   */
  observeStep(base: TurnCapableBase, run: readonly unknown[] | undefined, step: unknown): void {
    if (typeof base.recordToolCall !== "function" || step === null || typeof step !== "object") {
      return;
    }
    const content = (step as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    const names = new Map<string, string>();
    const outcomes: { id: string; error?: unknown }[] = [];
    for (const part of content as { type?: string; toolCallId?: string; toolName?: string }[]) {
      if (typeof part?.toolCallId !== "string") continue;
      if (part.type === "tool-call" && typeof part.toolName === "string") {
        names.set(part.toolCallId, part.toolName);
      } else if (part.type === "tool-result") {
        outcomes.push({ id: part.toolCallId });
      } else if (part.type === "tool-error") {
        outcomes.push({
          id: part.toolCallId,
          error: (part as { error?: unknown }).error ?? "error",
        });
      }
    }
    const turnId =
      base.currentTurnId?.() ?? (run === undefined ? undefined : this.#byRun.get(run)?.id);
    for (const outcome of outcomes) {
      const toolName =
        names.get(outcome.id) ??
        (content as { toolCallId?: string; toolName?: string }[]).find(
          (part) => part?.toolCallId === outcome.id && typeof part.toolName === "string",
        )?.toolName;
      if (toolName === undefined) continue;
      if (CAPABILITY_TOOL_IDS.has(toolName) || this.recordedPassthroughIds.has(toolName)) continue;
      base.recordToolCall({
        toolId: toolName,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(turnId === undefined ? {} : { turnId }),
      });
    }
  }

  #find(messages: unknown): TurnEntry | undefined {
    if (!Array.isArray(messages)) return undefined;
    const prompt = messages as ModelMessage[];
    let lastUser = -1;
    prompt.forEach((message, position) => {
      if (message?.role === "user") lastUser = position;
    });
    for (const message of prompt.slice(lastUser + 1)) {
      if (!Array.isArray(message?.content)) continue;
      for (const part of message.content) {
        if (part.type !== "tool-call" || part.toolName !== SEARCH_CAPABILITIES_ID) continue;
        const entry = this.#byRecallId.get(part.toolCallId);
        if (entry !== undefined) return entry;
      }
    }
    const key = userMessageKey(prompt);
    return key === undefined ? undefined : this.#byUserMessage.get(key);
  }
}

function remember(map: Map<string, TurnEntry>, key: string, entry: TurnEntry): void {
  map.delete(key);
  map.set(key, entry);
  if (map.size > MAX_TRACKED_TURNS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** The recall pair's call id: the `search_capabilities` call the core minted. */
export function recallCallId(messages: readonly ModelMessage[]): string | undefined {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part.type === "tool-call" &&
        part.toolName === SEARCH_CAPABILITIES_ID &&
        typeof part.toolCallId === "string"
      ) {
        return part.toolCallId;
      }
    }
  }
  return undefined;
}

// Position by user-message count rather than array index: a host may or may not
// keep a system message in the array, and the AI SDK hands tools the prompt
// without it.
function userMessageKey(messages: readonly ModelMessage[]): string | undefined {
  let userCount = 0;
  let text: string | undefined;
  for (const message of messages) {
    if (message?.role !== "user") continue;
    userCount++;
    text = messageText(message);
  }
  return text === undefined ? undefined : `${userCount}\u0000${text}`;
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
