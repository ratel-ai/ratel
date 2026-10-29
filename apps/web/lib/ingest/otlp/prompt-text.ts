import { parsedValue } from "./attr-resolve";
import type { AttrMap } from "./types";

/**
 * The last user message of a model call, read across OTel dialects, for
 * naming and placing workflows. Present only when the customer captures
 * content (opt-in everywhere but the AI SDK); absent otherwise.
 */

export const MAX_PROMPT_CHARS = 1_000;

const MESSAGE_LIST_KEYS = [
  "gen_ai.input.messages",
  "ai.prompt.messages",
  "input.value",
  "ai.prompt",
  "mastra.model_step.input",
  "mastra.model_generation.input",
] as const;

function textOfPart(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const record = part as Record<string, unknown>;
  if (record.type !== undefined && record.type !== "text") return "";
  const text = record.content ?? record.text;
  return typeof text === "string" ? text : "";
}

function textOfMessage(message: Record<string, unknown>): string {
  const body = message.parts ?? message.content;
  if (typeof body === "string") return body;
  if (Array.isArray(body)) return body.map(textOfPart).filter(Boolean).join("\n");
  return "";
}

function messageList(value: unknown): Record<string, unknown>[] | null {
  const parsed = parsedValue(value as never);
  if (Array.isArray(parsed))
    return parsed.filter((m): m is Record<string, unknown> => !!m && typeof m === "object");
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.messages)) return messageList(record.messages);
    if (typeof record.prompt === "string") return [{ role: "user", content: record.prompt }];
  }
  return null;
}

/** Flattened `<prefix>.N.<role|content>` attributes (OpenInference, legacy GenAI) as messages. */
function indexedMessages(attributes: AttrMap, prefix: RegExp): Record<string, unknown>[] {
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(attributes)) {
    const match = prefix.exec(key);
    if (!match) continue;
    const index = Number(match[1]);
    const message = byIndex.get(index) ?? {};
    message[match[2]] = value;
    byIndex.set(index, message);
  }
  return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, message]) => message);
}

function lastUserText(messages: readonly Record<string, unknown>[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const text = textOfMessage(messages[i]).trim();
    if (text) return text.slice(0, MAX_PROMPT_CHARS);
  }
  return null;
}

/** The last user message in a model call's captured input, or null. */
export function promptOf(attributes: AttrMap): string | null {
  for (const key of MESSAGE_LIST_KEYS) {
    const list = messageList(attributes[key]);
    const text = list ? lastUserText(list) : null;
    if (text) return text;
  }
  for (const prefix of [
    /^llm\.input_messages\.(\d+)\.message\.(role|content)$/,
    /^gen_ai\.prompt\.(\d+)\.(role|content)$/,
  ]) {
    const text = lastUserText(indexedMessages(attributes, prefix));
    if (text) return text;
  }
  return null;
}

/**
 * Openings of messages that a system, not a person, sends to start a turn: a
 * background task reporting back, a subagent's brief, a task-state update.
 * Such turns are told apart in Agent health (`system_turn_failing`), since
 * they fail and run long in ways a person's request does not.
 */
const SYSTEM_PROMPT =
  /^\s*(?:background task\b|\[task state\]|you are the subagent\b|<task-notification>|\[system notification\]|system notification:|task [\w-]+ (?:has )?(?:completed|failed|finished)\b)/i;

/** Whether a turn's opening message came from a system rather than a person. */
export function isSystemPrompt(text: string): boolean {
  return SYSTEM_PROMPT.test(text);
}
