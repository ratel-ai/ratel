import { createHash } from "node:crypto";
import type {
  CloudEvent,
  CloudMessage,
  CloudToolDef,
  ContentBlock,
  MessageContent,
} from "@/lib/ingest/cloud-schema";

/**
 * Redaction of one model call before it enters a dataset (RC-1126).
 *
 * Deterministic, pattern-based redaction: each rule is a regular expression,
 * sometimes with a checksum (Luhn for cards, mod-97 for IBAN, the check letter
 * of a codice fiscale). It does NOT find person names or postal addresses.
 *
 * Each match becomes a typed placeholder such as `[EMAIL_1]`. In one call, the
 * same value always gets the same index, so the text stays coherent. The
 * function is pure: the same input gives the same output and the same counts.
 *
 * Any change to {@link REDACTION_RULES} must raise {@link REDACTION_VERSION}:
 * a dataset records the version it was built with, and a test pins the pair.
 */

export const REDACTION_VERSION = 1;

export const REDACTION_KINDS = [
  "secret",
  "email",
  "iban",
  "payment_card",
  "national_id",
  "phone",
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];
export type RedactionCounts = Record<RedactionKind, number>;

/** The parts of a call that carry text. */
export type CallContent = Pick<CloudEvent, "system" | "tools" | "messages" | "output">;

export interface RedactionResult<T extends CallContent> {
  content: T;
  counts: RedactionCounts;
}

export interface RedactionRule {
  /** Stable name; part of the rules fingerprint. */
  name: string;
  kind: RedactionKind;
  pattern: RegExp;
  /** Extra check on the matched text (a checksum). A match that fails it stays. */
  validate?: (match: string) => boolean;
  /** Which capture group is the value to replace. 0 (default) is the whole match. */
  group?: number;
}

const PLACEHOLDER: Record<RedactionKind, string> = {
  secret: "SECRET",
  email: "EMAIL",
  iban: "IBAN",
  payment_card: "CARD",
  national_id: "NATIONAL_ID",
  phone: "PHONE",
};

/**
 * The rules, applied in this order: secrets first (they hold digit runs that
 * look like other kinds), phone last (its shape is the loosest). Add a rule
 * here, then raise {@link REDACTION_VERSION}.
 */
export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    name: "private_key_block",
    kind: "secret",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    name: "bearer_token",
    kind: "secret",
    pattern: /\bBearer\s+([A-Za-z0-9\-._~+/]{16,}=*)/g,
    group: 1,
  },
  {
    name: "jwt",
    kind: "secret",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  { name: "openai_anthropic_key", kind: "secret", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: "stripe_key", kind: "secret", pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  {
    name: "github_token",
    kind: "secret",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
  },
  { name: "aws_access_key_id", kind: "secret", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "slack_token", kind: "secret", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "google_api_key", kind: "secret", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  {
    name: "email",
    kind: "email",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },
  {
    name: "iban",
    kind: "iban",
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    validate: ibanChecksumOk,
  },
  {
    name: "payment_card",
    kind: "payment_card",
    pattern: /(?<![\w.-])\d(?:[ -]?\d){12,18}(?![\w-]|\.\d)/g,
    validate: luhnOk,
  },
  {
    name: "it_codice_fiscale",
    kind: "national_id",
    pattern:
      /\b[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]\b/gi,
    validate: codiceFiscaleOk,
  },
  {
    name: "us_ssn",
    kind: "national_id",
    pattern: /(?<![\w-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\w-])/g,
  },
  {
    name: "phone",
    kind: "phone",
    pattern:
      /(?<![\w.+-])(?:\+\d{1,3}[ -]?)?(?:\(\d{1,4}\)[ -]?)?\d{2,4}(?:[ -]\d{2,4}){1,4}(?![\w-]|\.\d)|(?<![\w.+-])\+\d{8,15}(?![\w-]|\.\d)/g,
    validate: phoneShapeOk,
  },
];

/** Redact one call. Pure: same input, same output and counts. */
export function redactCall<T extends CallContent>(call: T): RedactionResult<T> {
  const ctx = new RedactionContext();
  const content: T = {
    ...call,
    ...(call.system !== undefined ? { system: ctx.text(call.system) } : {}),
    ...(call.tools !== undefined ? { tools: call.tools.map((tool) => redactTool(tool, ctx)) } : {}),
    messages: call.messages.map((message) => redactMessage(message, ctx)),
    ...(call.output !== undefined
      ? { output: call.output.map((message) => redactMessage(message, ctx)) }
      : {}),
  };
  return { content, counts: ctx.counts };
}

/** Redact one string with a fresh context (placeholders indexed from 1). */
export function redactText(text: string): { text: string; counts: RedactionCounts } {
  const ctx = new RedactionContext();
  return { text: ctx.text(text), counts: ctx.counts };
}

export function emptyCounts(): RedactionCounts {
  return Object.fromEntries(REDACTION_KINDS.map((kind) => [kind, 0])) as RedactionCounts;
}

/** Sum of two count records; for the dataset's redaction report. */
export function addCounts(a: RedactionCounts, b: RedactionCounts): RedactionCounts {
  const sum = emptyCounts();
  for (const kind of REDACTION_KINDS) sum[kind] = a[kind] + b[kind];
  return sum;
}

/** A fingerprint of the rule list. The version test pins it next to {@link REDACTION_VERSION}. */
export function redactionRulesFingerprint(): string {
  const shape = REDACTION_RULES.map((rule) => [
    rule.name,
    rule.kind,
    rule.pattern.source,
    rule.pattern.flags,
    rule.validate?.name ?? null,
    rule.group ?? 0,
  ]);
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

/** Per-call state: counts and the placeholder index of each value seen. */
class RedactionContext {
  readonly counts = emptyCounts();
  private readonly indexes = new Map<string, number>();
  private readonly nextIndex = emptyCounts();

  text(input: string): string {
    let out = input;
    for (const rule of REDACTION_RULES) out = this.apply(rule, out);
    return out;
  }

  private apply(rule: RedactionRule, input: string): string {
    return input.replace(rule.pattern, (match: string, ...groups: unknown[]) => {
      const value = rule.group ? (groups[rule.group - 1] as string | undefined) : match;
      if (value === undefined) return match;
      if (rule.validate && !rule.validate(value)) return match;
      const placeholder = this.placeholder(rule.kind, value);
      return rule.group ? match.replace(value, placeholder) : placeholder;
    });
  }

  private placeholder(kind: RedactionKind, value: string): string {
    this.counts[kind] += 1;
    const key = `${kind}:${normalizeValue(kind, value)}`;
    let index = this.indexes.get(key);
    if (index === undefined) {
      this.nextIndex[kind] += 1;
      index = this.nextIndex[kind];
      this.indexes.set(key, index);
    }
    return `[${PLACEHOLDER[kind]}_${index}]`;
  }
}

function redactTool(tool: CloudToolDef, ctx: RedactionContext): CloudToolDef {
  return {
    ...tool,
    ...(tool.description !== undefined ? { description: ctx.text(tool.description) } : {}),
    parameters: redactJson(tool.parameters, ctx) as Record<string, unknown>,
  };
}

function redactMessage(message: CloudMessage, ctx: RedactionContext): CloudMessage {
  if (message.role === "tool") return { ...message, content: ctx.text(message.content) };
  return { ...message, content: redactContent(message.content, ctx) };
}

function redactContent(content: MessageContent, ctx: RedactionContext): MessageContent {
  if (typeof content === "string") return ctx.text(content);
  return content.map((block) => redactBlock(block, ctx));
}

function redactBlock(block: ContentBlock, ctx: RedactionContext): ContentBlock {
  switch (block.type) {
    case "text":
      return { ...block, text: ctx.text(block.text) };
    case "tool_call":
      return { ...block, arguments: redactJson(block.arguments, ctx) as Record<string, unknown> };
    case "image":
    case "file":
      return block.url !== undefined ? { ...block, url: ctx.text(block.url) } : block;
  }
}

/** Redact every string value in a JSON value. Keys stay as they are. */
function redactJson(value: unknown, ctx: RedactionContext): unknown {
  if (typeof value === "string") return ctx.text(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, ctx));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJson(item, ctx)]),
    );
  }
  return value;
}

function normalizeValue(kind: RedactionKind, value: string): string {
  if (kind === "email" || kind === "national_id") return value.toLowerCase();
  if (kind === "secret") return value;
  return value.replace(/[^0-9A-Za-z+]/g, "").toUpperCase();
}

function luhnOk(match: string): boolean {
  const digits = match.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function ibanChecksumOk(match: string): boolean {
  const iban = match.replace(/ /g, "");
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const CF_ODD: Record<string, number> = {
  "0": 1,
  "1": 0,
  "2": 5,
  "3": 7,
  "4": 9,
  "5": 13,
  "6": 15,
  "7": 17,
  "8": 19,
  "9": 21,
  A: 1,
  B: 0,
  C: 5,
  D: 7,
  E: 9,
  F: 13,
  G: 15,
  H: 17,
  I: 19,
  J: 21,
  K: 2,
  L: 4,
  M: 18,
  N: 20,
  O: 11,
  P: 3,
  Q: 6,
  R: 8,
  S: 12,
  T: 14,
  U: 16,
  V: 10,
  W: 22,
  X: 25,
  Y: 24,
  Z: 23,
};

function codiceFiscaleOk(match: string): boolean {
  const cf = match.toUpperCase();
  let sum = 0;
  for (let i = 0; i < 15; i += 1) {
    const char = cf[i]!;
    // Positions are 1-indexed in the spec: index 0 is "odd".
    sum += i % 2 === 0 ? CF_ODD[char]! : /\d/.test(char) ? Number(char) : char.charCodeAt(0) - 65;
  }
  return String.fromCharCode(65 + (sum % 26)) === cf[15];
}

/** 9 to 15 digits, not a date (2026-11-20 …) and not the SSN shape the SSN rule refused. */
function phoneShapeOk(match: string): boolean {
  const digits = match.replace(/\D/g, "").length;
  if (digits < 9 || digits > 15) return false;
  return !/^\d{4}-\d{2}-\d{2}/.test(match) && !/^\d{3}-\d{2}-\d{4}$/.test(match);
}
