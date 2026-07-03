import type { Event } from "./types.js";

/** One validation failure: a JSON-ish `path` into the event and a `message`. */
export interface Issue {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; issues: Issue[] };

// Ingest bounds + structural rules, mirrored from the Rust spec's serde gate and the
// cloud consumer's schema (`cloud-schema.ts`) so an event that passes here is one the
// endpoint accepts. TypeScript's compile-time types are erased at runtime, so — unlike
// Rust — the pure-language client must re-check role/type/finish-reason/number shape
// itself; that is what the extra checks below (vs the Rust `validate`) exist for.
const MAX_INT4 = 2_147_483_647; // Postgres `integer` upper bound
const MAX_TEXT = 2_000_000;
const MAX_BLOB = 20_000_000;
const MAX_NAME = 1_024;
const MAX_URL = 8_192;
const MAX_BLOCKS = 20_000;
const MAX_MESSAGES = 10_000;
const MAX_TOOLS = 2_000;
const MAX_STOP = 100;

const ROLES = new Set(["user", "assistant", "tool"]);
const BLOCK_TYPES = new Set(["text", "tool_call", "image", "file"]);
const FINISH_REASONS = new Set(["stop", "length", "tool_call", "content_filter", "refusal"]);
const SOURCE_KEYS = ["skills", "tools", "history", "memory", "user_input"] as const;

type Fail = (path: string, message: string) => void;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-negative integer within the Postgres `int4` range (token counts). */
function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INT4;
}

/** A required identifier: a non-empty string within the name-length bound. */
function checkName(value: unknown, path: string, fail: Fail): void {
  if (typeof value !== "string" || value.trim() === "") {
    fail(path, "must not be empty");
  } else if (value.length > MAX_NAME) {
    fail(path, "exceeds maximum length");
  }
}

/** A free-text field: must be a string, bounded in length (may be empty). */
function checkText(value: unknown, max: number, path: string, fail: Fail): void {
  if (typeof value !== "string") {
    fail(path, "must be a string");
  } else if (value.length > max) {
    fail(path, "exceeds maximum length");
  }
}

/**
 * Check the semantic + structural invariants of an event — the rules the Rust spec
 * gets from serde plus its `validate`, restated here because runtime JS has no type
 * gate. Fully defensive: callers reach this through `sendEvent`, documented never to
 * throw, so malformed input (an `as any`, or an untyped JS caller) is *reported*.
 */
export function validate(event: Event): ValidationResult {
  const issues: Issue[] = [];
  const fail: Fail = (path, message) => issues.push({ path, message });
  const ev = event as unknown as Record<string, unknown>;

  checkName(ev.provider, "provider", fail);
  checkName(ev.model, "model", fail);
  // `ts` is only required non-empty (and bounded): the consumer tolerates any string
  // and falls back to receipt time, so a strict format check would reject events the
  // endpoint accepts.
  checkName(ev.ts, "ts", fail);

  const messages = Array.isArray(ev.messages) ? ev.messages : [];
  if (messages.length === 0) fail("messages", "must not be empty");
  if (messages.length > MAX_MESSAGES) fail("messages", "too many messages");

  const tools = Array.isArray(ev.tools) ? ev.tools : [];
  if (tools.length > MAX_TOOLS) fail("tools", "too many tools");
  tools.forEach((tool, i) => {
    if (!isObject(tool)) {
      fail(`tools[${i}]`, "must be an object");
      return;
    }
    checkName(tool.name, `tools[${i}].name`, fail);
    if (tool.description !== undefined)
      checkText(tool.description, MAX_TEXT, `tools[${i}].description`, fail);
    if (!isObject(tool.parameters)) fail(`tools[${i}].parameters`, "must be a JSON Schema object");
  });

  messages.forEach((message, i) => {
    const base = `messages[${i}]`;
    if (!isObject(message)) {
      fail(base, "must be an object");
      return;
    }
    if (!ROLES.has(message.role as string)) {
      fail(`${base}.role`, "must be one of: user, assistant, tool");
      return;
    }
    if (message.role === "tool") {
      checkName(message.tool_call_id, `${base}.tool_call_id`, fail);
      checkText(message.content, MAX_TEXT, `${base}.content`, fail);
      return;
    }
    validateContent(message.content, message.role === "assistant", base, fail);
  });

  if (ev.finish_reason !== undefined && !FINISH_REASONS.has(ev.finish_reason as string)) {
    fail("finish_reason", "must be a known finish reason");
  }
  if (ev.latency_ms !== undefined) {
    const l = ev.latency_ms;
    if (typeof l !== "number" || l < 0 || l > MAX_INT4) {
      fail("latency_ms", "must be a non-negative number within range");
    }
  }
  validateUsage(ev.usage, fail);
  validateParams(ev.params, fail);
  validateSavings(ev.savings, fail);

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function validateSourceTokens(src: unknown, base: string, fail: Fail): void {
  if (!isObject(src)) {
    fail(base, "must be an object");
    return;
  }
  for (const key of SOURCE_KEYS) {
    const value = src[key];
    if (value !== undefined && !isTokenCount(value))
      fail(`${base}.${key}`, "must be a non-negative integer within range");
  }
}

function validateSavings(savings: unknown, fail: Fail): void {
  if (savings === undefined) return;
  if (!isObject(savings)) {
    fail("savings", "must be an object");
    return;
  }
  validateSourceTokens(savings.tokens_by_category, "savings.tokens_by_category", fail);
  if (savings.saved_by_category !== undefined)
    validateSourceTokens(savings.saved_by_category, "savings.saved_by_category", fail);
  if (savings.saveable_by_category !== undefined)
    validateSourceTokens(savings.saveable_by_category, "savings.saveable_by_category", fail);
}

function validateContent(content: unknown, allowToolCall: boolean, base: string, fail: Fail): void {
  if (typeof content === "string") {
    checkText(content, MAX_TEXT, `${base}.content`, fail);
    return;
  }
  if (!Array.isArray(content)) {
    fail(`${base}.content`, "must be a string or an array of blocks");
    return;
  }
  if (content.length === 0) {
    fail(`${base}.content`, "blocks array must not be empty");
    return;
  }
  if (content.length > MAX_BLOCKS) fail(`${base}.content`, "too many content blocks");
  content.forEach((block, j) => {
    validateBlock(block, allowToolCall, `${base}.content[${j}]`, fail);
  });
}

function validateBlock(block: unknown, allowToolCall: boolean, path: string, fail: Fail): void {
  if (!isObject(block)) {
    fail(path, "must be an object");
    return;
  }
  if (!BLOCK_TYPES.has(block.type as string)) {
    fail(path, "unknown block type");
    return;
  }
  if (block.type === "text") {
    checkText(block.text, MAX_TEXT, `${path}.text`, fail);
  } else if (block.type === "tool_call") {
    if (!allowToolCall) fail(path, "tool_call blocks are only allowed in assistant messages");
    checkName(block.id, `${path}.id`, fail);
    checkName(block.name, `${path}.name`, fail);
    if (!isObject(block.arguments)) fail(`${path}.arguments`, "must be a parsed object");
  } else {
    validateMedia(block, path, fail);
  }
}

function validateMedia(block: Record<string, unknown>, path: string, fail: Fail): void {
  // An explicit `null` (some JSON serializers emit it for an absent field) is not a
  // string and not "absent" to the consumer's Zod schema, which rejects it — so we do too.
  if (block.source !== undefined && typeof block.source !== "string")
    fail(`${path}.source`, "must be a string");
  if (block.url !== undefined && typeof block.url !== "string")
    fail(`${path}.url`, "must be a string");
  const hasSource = typeof block.source === "string";
  const hasUrl = typeof block.url === "string";
  if (hasSource === hasUrl) fail(path, "exactly one of `source` or `url` must be set");
  if (hasSource && (block.source as string).length > MAX_BLOB)
    fail(`${path}.source`, "exceeds maximum length");
  if (hasUrl && (block.url as string).length > MAX_URL)
    fail(`${path}.url`, "exceeds maximum length");
  checkName(block.media_type, `${path}.media_type`, fail);
}

function validateUsage(usage: unknown, fail: Fail): void {
  if (usage === undefined) return;
  if (!isObject(usage)) {
    fail("usage", "must be an object");
    return;
  }
  if (!isTokenCount(usage.input_tokens))
    fail("usage.input_tokens", "must be a non-negative integer within range");
  if (!isTokenCount(usage.output_tokens))
    fail("usage.output_tokens", "must be a non-negative integer within range");
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  if (usage.cached_tokens !== undefined) {
    if (!isTokenCount(usage.cached_tokens))
      fail("usage.cached_tokens", "must be a non-negative integer within range");
    else if (usage.cached_tokens > input)
      fail("usage.cached_tokens", "must not exceed input_tokens");
  }
  if (usage.reasoning_tokens !== undefined) {
    if (!isTokenCount(usage.reasoning_tokens))
      fail("usage.reasoning_tokens", "must be a non-negative integer within range");
    else if (usage.reasoning_tokens > output)
      fail("usage.reasoning_tokens", "must not exceed output_tokens");
  }
}

function validateParams(params: unknown, fail: Fail): void {
  if (params === undefined) return;
  if (!isObject(params)) {
    fail("params", "must be an object");
    return;
  }
  if (params.stop === undefined) return;
  if (!Array.isArray(params.stop)) {
    fail("params.stop", "must be an array of strings");
    return;
  }
  if (params.stop.length > MAX_STOP) fail("params.stop", "too many stop sequences");
  params.stop.forEach((s, i) => {
    checkText(s, MAX_NAME, `params.stop[${i}]`, fail);
  });
}
