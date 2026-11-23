import type { OutcomeCause } from "@/lib/readings/trace-signals/outcomes/kinds";

/**
 * Why a call failed, read from its error message alone: the message is
 * normalized (the values that make two messages of one shape differ are
 * taken out), then sorted by a small ordered pattern table into bad
 * arguments, wrong reference, tool fault or not allowed. A message no
 * pattern knows is `other`. Pure: no clock, no I/O, no imports beyond the
 * vocabulary, so any reading of errors can share it.
 *
 * Most messages are a bare code (`validation_failed`) or one short sentence
 * ("Record not found"), so the patterns read words: `_`, `-` and camelCase
 * all split into words first.
 *
 * PRIVACY: a normalized message is still the customer's text. It is for
 * grouping in memory; only the cause is stored.
 */

/** A normalized message is cut here. Real ones are one short sentence. */
const MAX_KEY_CHARS = 200;
/** How much of a long message the patterns read. */
const MAX_READ_CHARS = 1000;

const URL = /\bhttps?:\/\/[^\s"'<>)]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** Double quotes, curly quotes and backticks; single quotes only when they are not an apostrophe. */
const QUOTED = /"[^"\n]*"|“[^”\n]*”|`[^`\n]*`|(?<![\w])'[^'\n]*'(?![\w])/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** A letters-and-digits token of five or more characters with at least two digits: a record id, a hash, a ULID. */
const ID_TOKEN = /\b(?=[a-z0-9]{5,}\b)(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d[a-z0-9]*\d)[a-z0-9]+\b/gi;
const NUMBER = /\d+(?:[.,]\d+)*/g;

/** The fields a structured error keeps its message in, in reading order. */
const MESSAGE_FIELDS = ["message", "error", "detail", "code", "type"] as const;

/** The text of an error as sent: the string, or the message fields of a JSON object in it. */
function messageOf(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("{")) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return text;
    const record = parsed as Record<string, unknown>;
    const parts = MESSAGE_FIELDS.map((field) => record[field]).filter(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    return parts.length > 0 ? [...new Set(parts)].join(". ") : text;
  } catch {
    return text;
  }
}

/** The message with its values taken out: urls, emails, quoted values and ids. Numbers stay (a status code is a number). */
function withoutValues(text: string): string {
  return text
    .slice(0, MAX_READ_CHARS)
    .replace(URL, "<url>")
    .replace(EMAIL, "<email>")
    .replace(QUOTED, "<value>")
    .replace(UUID, "<id>")
    .replace(ID_TOKEN, "<id>");
}

/** Up to the end of the first sentence, or the first line. What follows is advice or a list. */
function firstSentence(text: string): string {
  const cut = text.search(/[.!?](?=\s)|\n/);
  return cut < 0 ? text : text.slice(0, cut);
}

const tidy = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.!?:;,]+$/, "");

/** Lowercase words, with `snake_case`, `kebab-case`, `camelCase` and punctuation split. Placeholders are dropped. */
function wordsOf(text: string): string {
  return text
    .replace(/<(?:url|email|value|id)>/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .trim();
}

/**
 * The grouping form of an error message: its first sentence, lowercased, with
 * urls, emails, quoted values, ids and numbers replaced by placeholders, so
 * two messages that differ only in the record they name are one. Empty when
 * there is nothing to read.
 */
export function normalizeErrorMessage(raw: string | null | undefined): string {
  if (!raw) return "";
  const stripped = withoutValues(messageOf(raw));
  return tidy(firstSentence(stripped).toLowerCase().replace(NUMBER, "<n>")).slice(0, MAX_KEY_CHARS);
}

export interface CausePattern {
  /** A stable name for the shape, for tests and counts. */
  id: string;
  cause: Exclude<OutcomeCause, "other">;
  /** Read against the message's lowercase words (`wordsOf`). */
  test: RegExp;
}

/**
 * The pattern table, first match wins.
 *
 * Order: a refusal first (a message that says "denied" is about access even
 * when it also names a record). Then a reference that did not resolve, ahead
 * of bad arguments: "not found or not accessible" is how a missing record is
 * reported, and "not accessible" there is not a refusal. Then what the caller
 * sent, then what the tool did. A bare "failed" comes last: after "validation
 * failed" and "authentication failed" it is the tool's own.
 */
export const CAUSE_PATTERNS: readonly CausePattern[] = [
  {
    id: "refused",
    cause: "not_allowed",
    test: /\b(?:forbidden|denied|unauthori[sz]ed|unauthenticated|permissions?|not (?:allowed|permitted|authori[sz]ed|declared|entitled)|read only|(?:http|status|code) 40[13])\b|^40[13]\b/,
  },
  {
    id: "sign_in",
    cause: "not_allowed",
    test: /\b(?:authenticat\w+|credentials?|api key|(?:token|session|key) (?:is |has )?(?:expired|revoked)|invalid (?:token|session)|not (?:signed|logged) in|(?:sign|log) ?in (?:failed|required))\b/,
  },
  {
    id: "plan_or_budget",
    cause: "not_allowed",
    test: /\b(?:insufficient (?:credits?|funds|balance|quota)|quota exceeded|over budget|budget exceeded|plan limit|upgrade (?:your|the) plan|payment required)\b/,
  },
  {
    // "Only workspace-authored pages can be edited here": a rule about who or what may.
    id: "only_some_may",
    cause: "not_allowed",
    test: /\bonly\b.{0,80}\b(?:can|may|are allowed|is allowed)\b/,
  },
  {
    // Ahead of the argument patterns: "rate limit exceeded" and "deadline exceeded" are not a value too large.
    id: "transient",
    cause: "tool_fault",
    test: /\b(?:time(?:d)? ?out|deadline|rate limit\w*|too many requests|throttl\w+|try again later|temporar\w+|connection (?:refused|reset|closed|lost|error|failed)|network error|socket hang up|econn\w+|enotfound|etimedout|(?:http|status|code) 429)\b|^429\b/,
  },
  {
    id: "not_found",
    cause: "wrong_reference",
    test: /\b(?:not found|no such|does not exist|doesn't exist|do not exist|no longer exists?|could not find|couldn't find|cannot find|can't find|unable to find|not accessible|inaccessible|(?:http|status|code) 404)\b|^404\b/,
  },
  {
    // "No member matched …", "… returned no record": a lookup that came back empty.
    id: "no_match",
    cause: "wrong_reference",
    test: /\bno (?:\w+ ){0,2}match(?:ed|es|ing)?\b|\bmatch(?:ed|es) no\b|\b(?:returned|found|resolved to) no\b|\bunknown (?:id|key|reference|record|entity|resource|tool|user|project|task)\b/,
  },
  {
    id: "invalid",
    cause: "bad_arguments",
    test: /\b(?:invalid|validation|malformed|unprocessable|bad request|not a valid|unsupported|unrecogni[sz]ed|unexpected (?:token|type|field|argument|property|value|key)|schema|parse|parsing|type error|(?:http|status|code) (?:400|422))\b|^(?:400|422)\b/,
  },
  {
    id: "required",
    cause: "bad_arguments",
    test: /\b(?:required|missing (?:a |an |the )?(?:required )?(?:field|param\w*|argument|property|value|key|input)s?|must|should be|expected|(?:cannot|can't|may not) be (?:empty|null|blank|changed|set|updated|modified|negative))\b/,
  },
  {
    // "… must be 500 characters or less", "too long", "out of range".
    id: "limit",
    cause: "bad_arguments",
    test: /\b(?:too (?:long|short|large|small|big)|too many|or (?:less|fewer|more)|at (?:most|least)|exceeds?|exceeded|out of range|maximum|minimum)\b/,
  },
  {
    // "A child's region is inherited from its parent": a field the caller may not set.
    id: "not_settable",
    cause: "bad_arguments",
    test: /\b(?:is|are) (?:inherited|derived|determined|computed|set) (?:from|by)\b|\balready exists?\b|\bduplicate\b|\bconflicts? with\b/,
  },
  {
    id: "server",
    cause: "tool_fault",
    test: /\b(?:internal|server error|unavailable|overloaded|unexpected|unknown error|crash\w*|panic|exception|traceback|null pointer|undefined is not|cannot read propert\w+|(?:http|status|code) 5\d\d)\b|^5\d\d\b/,
  },
  {
    id: "failed",
    cause: "tool_fault",
    test: /\b(?:fail(?:ed|ure|s)?|aborted|could not complete|unable to complete)\b/,
  },
];

function matchPattern(words: string): CausePattern | null {
  if (words === "") return null;
  return CAUSE_PATTERNS.find((pattern) => pattern.test.test(words)) ?? null;
}

export interface ErrorReading {
  /** The normalized message ({@link normalizeErrorMessage}): in memory only, never stored. */
  key: string;
  cause: OutcomeCause;
  /** The pattern that decided it; null for `other`. */
  pattern: string | null;
}

/**
 * One error message read: its grouping key and its cause. The first sentence
 * decides; the rest of the message is read only when the first says nothing
 * ("Request failed. …" still reads as a failure). Null when the message is
 * empty, which is not `other`: there was nothing to read.
 */
export function readError(raw: string | null | undefined): ErrorReading | null {
  if (!raw || raw.trim() === "") return null;
  const stripped = withoutValues(messageOf(raw));
  const key = normalizeErrorMessage(raw);
  const pattern = matchPattern(wordsOf(firstSentence(stripped))) ?? matchPattern(wordsOf(stripped));
  return { key, cause: pattern?.cause ?? "other", pattern: pattern?.id ?? null };
}

/** The cause of one error message; null when it is empty. */
export function causeOfError(raw: string | null | undefined): OutcomeCause | null {
  return readError(raw)?.cause ?? null;
}

/** Counts of read errors by cause, and what landed in `other`. */
export interface ErrorCauseCounts {
  byCause: Record<OutcomeCause, number>;
  /** Distinct normalized messages no pattern knew: how many shapes the table misses. */
  otherShapes: number;
}

/** A tally of error readings: every read error is counted once, `other` included. */
export function createCauseTally() {
  const byCause: Record<OutcomeCause, number> = {
    bad_arguments: 0,
    wrong_reference: 0,
    tool_fault: 0,
    not_allowed: 0,
    other: 0,
  };
  const others = new Set<string>();
  return {
    add(reading: ErrorReading): void {
      byCause[reading.cause] += 1;
      if (reading.cause === "other") others.add(reading.key);
    },
    finish: (): ErrorCauseCounts => ({ byCause: { ...byCause }, otherShapes: others.size }),
  };
}
