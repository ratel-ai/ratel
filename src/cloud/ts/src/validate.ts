import type { Content, Event } from "./types.js";

/** One validation failure: a JSON-ish `path` into the event and a `message`. */
export interface Issue {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; issues: Issue[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Check the semantic invariants of an event — the same rules the Rust spec's
 * `validate` enforces. Fully defensive: callers reach this through `sendEvent`,
 * which is documented never to throw, so malformed input (a JS caller or `as
 * any` omitting required fields) must be *reported*, never thrown on.
 */
export function validate(event: Event): ValidationResult {
  const issues: Issue[] = [];
  const fail = (path: string, message: string) => issues.push({ path, message });

  if (!isNonEmptyString(event.provider)) fail("provider", "must not be empty");
  if (!isNonEmptyString(event.model)) fail("model", "must not be empty");
  if (!isNonEmptyString(event.ts)) fail("ts", "must not be empty");

  const messages = toArray(event.messages);
  if (messages.length === 0) fail("messages", "must not be empty");

  toArray(event.tools).forEach((tool, i) => {
    if (!isObject(tool)) {
      fail(`tools[${i}]`, "must be an object");
      return;
    }
    if (!isNonEmptyString(tool.name)) fail(`tools[${i}].name`, "must not be empty");
    if (!isObject(tool.parameters)) {
      fail(`tools[${i}].parameters`, "must be a JSON Schema object");
    }
  });

  messages.forEach((message, i) => {
    const base = `messages[${i}]`;
    if (!isObject(message)) {
      fail(base, "must be an object");
      return;
    }
    if (message.role === "tool") {
      if (!isNonEmptyString(message.tool_call_id)) {
        fail(`${base}.tool_call_id`, "must not be empty");
      }
      return;
    }
    validateContent(message.content as Content, message.role === "assistant", base, fail);
  });

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function validateContent(
  content: Content,
  allowToolCall: boolean,
  base: string,
  fail: (path: string, message: string) => void,
): void {
  if (!Array.isArray(content)) return;
  content.forEach((block, j) => {
    const path = `${base}.content[${j}]`;
    if (!isObject(block)) {
      fail(path, "must be an object");
      return;
    }
    if (block.type === "tool_call") {
      if (!allowToolCall) {
        fail(path, "tool_call blocks are only allowed in assistant messages");
      }
      if (!isObject(block.arguments)) {
        fail(`${path}.arguments`, "must be a parsed object");
      }
    } else if (block.type === "image" || block.type === "file") {
      if ((block.source != null) === (block.url != null)) {
        fail(path, "exactly one of `source` or `url` must be set");
      }
      if (!isNonEmptyString(block.media_type)) {
        fail(`${path}.media_type`, "must not be empty");
      }
    }
  });
}
