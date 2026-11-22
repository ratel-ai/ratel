/**
 * The rules of a fake tool answer (spec §3.6), with no I/O. A fake-mode tool
 * call is answered in this order: a value the reviewer pinned in the session,
 * a recorded call of the tool with the same normalized arguments, else a value
 * a small model generates. Generated fakes share one state ledger per session
 * and count against a silent daily cap per project.
 */

export type FakeSource = "pinned" | "recorded" | "generated";

/** A `tool.fake.request` from the worker. */
export interface FakeRequest {
  runId: string;
  callId: string;
  tool: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  args: unknown;
  /** The last messages of the conversation as the agent passed them to the tool (the worker sends up to 6). */
  messages?: readonly unknown[];
}

/** The `tool.fake.result` payload fields. */
export interface FakeAnswer {
  result: unknown;
  isError: boolean;
  source: FakeSource;
}

/** One recorded call of a tool: its arguments and what it returned. */
export interface RecordedCall {
  args: unknown;
  result: unknown;
  isError: boolean;
}

/** A chat message as the generator sees it: a role and plain text. */
export interface FakeMessage {
  role: string;
  text: string;
}

/** The session state ledger: what earlier fakes of any tool made true. */
export type FakeLedger = Record<string, unknown>;

export const DEFAULT_DAILY_CAP = 10_000;
export const MAX_EXAMPLES = 5;
export const MAX_MESSAGES = 6;
/** A ledger over this size is not stored: the previous one stays. */
export const MAX_LEDGER_BYTES = 16_000;
/** The run error over the cap. It never names the cap: the cap is internal. */
export const GENERIC_RUN_FAILURE = { code: "run_failed", message: "The run failed." } as const;
/** The tool result when generation fails: the run goes on, the model sees a tool error. */
export const GENERATION_FAILED_RESULT = { error: "The tool could not answer." } as const;

/**
 * The normalized form of tool arguments: JSON with object keys sorted, so two
 * calls whose arguments differ only in key order have the same key.
 */
export function argsKey(args: unknown): string {
  return canonicalJson(args);
}

/** The first recorded call whose normalized arguments equal these, or null. */
export function matchRecorded(calls: readonly RecordedCall[], args: unknown): RecordedCall | null {
  const key = argsKey(args);
  return calls.find((call) => argsKey(call.args) === key) ?? null;
}

/** The daily cap from `SANDBOX_FAKE_DAILY_CAP`; a missing or invalid value gives the default. */
export function dailyCap(raw: string | undefined): number {
  const value = Number(raw);
  return raw && Number.isInteger(value) && value >= 0 ? value : DEFAULT_DAILY_CAP;
}

/** The UTC day a generated fake counts against, `YYYY-MM-DD`. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** What the daily count after this generation means: go on, refuse, or refuse and alert (once, on the first refusal of the day). */
export function capDecision(
  countAfter: number,
  cap: number,
): "allow" | "refuse" | "refuse_and_alert" {
  if (countAfter <= cap) return "allow";
  return countAfter === cap + 1 ? "refuse_and_alert" : "refuse";
}

/**
 * Up to `limit` production results most like this call: ranked by the share
 * of argument tokens they have in common, newest first on a tie. The input is
 * newest first. Fake results never reach this function: the store excludes them.
 */
export function pickSimilar(
  calls: readonly RecordedCall[],
  args: unknown,
  limit: number = MAX_EXAMPLES,
): RecordedCall[] {
  const target = tokensOf(args);
  return calls
    .map((call, index) => ({ call, index, score: jaccard(target, tokensOf(call.args)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.call);
}

/** The last `limit` messages of a run input: a chat input's messages, else the input itself as one user message. */
export function lastMessages(input: unknown, limit: number = MAX_MESSAGES): FakeMessage[] {
  const messages = isPlainObject(input) && Array.isArray(input.messages) ? input.messages : null;
  if (!messages)
    return input === undefined || input === null ? [] : [{ role: "user", text: textOf(input) }];
  return messages
    .filter(isPlainObject)
    .map((message) => ({
      role: typeof message.role === "string" ? message.role : "user",
      text: textOf(message.content),
    }))
    .filter((message) => message.text.length > 0)
    .slice(-limit);
}

/** The new ledger to store, or null when it is not an object or too big (the previous one stays). */
export function acceptLedger(state: unknown): FakeLedger | null {
  if (!isPlainObject(state)) return null;
  return Buffer.byteLength(JSON.stringify(state), "utf8") <= MAX_LEDGER_BYTES ? state : null;
}

/** JSON with object keys sorted, so key order never reads as a change. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "undefined";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

function tokensOf(value: unknown): Set<string> {
  const text = typeof value === "string" ? value : canonicalJson(value);
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isPlainObject(part) && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined ? "" : canonicalJson(content);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
