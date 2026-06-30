import type { Content, Event, JsonValue } from "./types.js";

/** One validation failure: a JSON-ish `path` into the event and a `message`. */
export interface Issue {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; issues: Issue[] };

function isObject(value: JsonValue | undefined): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check the semantic invariants of an event — the same rules the Rust spec's
 * `validate` enforces. Structural shape is assumed (TypeScript / JSON parsing);
 * this catches empties, misplaced tool calls, and non-object payloads.
 */
export function validate(event: Event): ValidationResult {
  const issues: Issue[] = [];
  const fail = (path: string, message: string) => issues.push({ path, message });

  if (event.provider.trim() === "") fail("provider", "must not be empty");
  if (event.model.trim() === "") fail("model", "must not be empty");
  if (event.ts.trim() === "") fail("ts", "must not be empty");
  if (event.messages.length === 0) fail("messages", "must not be empty");

  (event.tools ?? []).forEach((tool, i) => {
    if (tool.name.trim() === "") fail(`tools[${i}].name`, "must not be empty");
    if (!isObject(tool.parameters)) {
      fail(`tools[${i}].parameters`, "must be a JSON Schema object");
    }
  });

  event.messages.forEach((message, i) => {
    const base = `messages[${i}]`;
    if (message.role === "tool") {
      if (message.tool_call_id.trim() === "") {
        fail(`${base}.tool_call_id`, "must not be empty");
      }
      return;
    }
    validateContent(message.content, message.role === "assistant", base, fail);
  });

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function validateContent(
  content: Content,
  allowToolCall: boolean,
  base: string,
  fail: (path: string, message: string) => void,
): void {
  if (typeof content === "string") return;
  content.forEach((block, j) => {
    const path = `${base}.content[${j}]`;
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
      if (block.media_type.trim() === "") {
        fail(`${path}.media_type`, "must not be empty");
      }
    }
  });
}
