import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  type AgentSpanDedupeDeps,
  resolveAgentSpanDedupe,
} from "@/lib/ingest/otlp/agent-span-dedupe";
import { decodeOtlp } from "@/lib/ingest/otlp/decode";
import { groupSpans } from "@/lib/ingest/otlp/group";
import { normalizeAiSdkSpans } from "@/lib/ingest/otlp/normalize-ai-sdk";
import type { EventWithMetric } from "@/lib/ingest/otlp/queries";
import { toRows } from "@/lib/ingest/otlp/reconstruct";
import { normalizeSemconvAliases } from "@/lib/ingest/otlp/semconv/aliases";
import type { OtlpRawExportBody } from "@/lib/ingest/otlp-raw/store";
import type { PriceBook } from "@/lib/ingest/pricing";

/**
 * Reprocess stored raw OTLP trace exports (`otlp_raw_exports`, RC-404): run
 * today's span-to-event mapping over each stored body again and patch the
 * `events` and `event_metrics` rows it derives, so a new mapping (a cache key
 * alias, a usage key) fixes data already received.
 *
 * A rebuilt event matches its stored row by dedupe hash, by the span-id hash
 * (rows hashed before a response id was read) or by trace id and span id (a
 * span id is unique only within its trace). A hash match counts only when the
 * stored row has no trace id or the same one: a hash held by another trace's
 * row is a conflict, left as it is. A matched row
 * gets its usage, cost, payload and metrics replaced when one of them differs.
 * A rebuilt event with no stored row is inserted (ON CONFLICT DO NOTHING). No
 * row is deleted, and `occurred_at`, `received_at` and `event_time` stay. The
 * comparison ignores jsonb key order and the numeric(12,6) cost rounding, so a
 * second run over the same bodies changes nothing.
 *
 * Log exports are skipped: their rows come from the logs route.
 */

export interface ReprocessOptions {
  projectId: string;
  since: Date;
  until?: Date;
  apply: boolean;
  /** Stored exports read and patched per batch. */
  pageSize?: number;
}

/** What ingest would decide for this project today. */
export interface ReprocessIngestFlags {
  /** `cloud-session-replay`: payloads keep each call's reply and settings. */
  captureReply: boolean;
  /** `cloud-otlp-agent-span-dedupe` storage lookup; absent, the flag is off. */
  agentSpanDedupe?: AgentSpanDedupeDeps;
  /** The project's price book (RC-482); absent, the current built-in prices. */
  prices?: PriceBook;
}

/** One stored event and its metrics row, as far as a reprocess compares them. */
export interface StoredEvent {
  id: string;
  dedupeHash: string | null;
  traceId: string | null;
  spanId: string | null;
  event: PatchableEvent;
  metric: PatchableMetric | null;
}

export type PatchableEvent = Pick<EventWithMetric["event"], (typeof EVENT_FIELDS)[number]>;
export type PatchableMetric = Pick<EventWithMetric["metric"], (typeof METRIC_FIELDS)[number]>;

export interface EventPatch {
  eventId: string;
  before: PatchableEvent;
  event: PatchableEvent;
  /** The full rebuilt metric: written whole, inserted when the row has none. */
  metric: EventWithMetric["metric"];
}

export interface ReprocessPlan {
  updates: EventPatch[];
  inserts: EventWithMetric[];
  unchanged: number;
  /**
   * Rebuilt events whose dedupe hash belongs to a stored row of another trace:
   * ingest dropped them as duplicates, so they are neither patched nor inserted.
   */
  conflicting: number;
}

export interface StoredEventKeys {
  dedupeHashes: string[];
  /** Stored rows of these traces are read and matched by span id in memory. */
  traceIds: string[];
}

export interface ReprocessDeps {
  readPage: (after: OtlpRawExportBody | undefined, limit: number) => Promise<OtlpRawExportBody[]>;
  flags: ReprocessIngestFlags;
  findStoredEvents: (keys: StoredEventKeys) => Promise<StoredEvent[]>;
  /** Write one batch's plan atomically. Only called with `apply`. */
  applyPlan: (plan: ReprocessPlan) => Promise<void>;
  /** Progress after each batch. */
  onBatch?: (report: ReprocessReport) => void;
}

export interface UsageTotals {
  events: number;
  inputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface ReprocessReport {
  applied: boolean;
  exports: number;
  skippedLogExports: number;
  undecodableExports: number;
  spans: number;
  rebuiltEvents: number;
  unchangedEvents: number;
  changedEvents: number;
  newEvents: number;
  /** Rebuilt events whose dedupe hash a stored row of another trace holds. */
  conflictingEvents: number;
  /** Over the changed events only: what they hold now and what they would hold. */
  before: UsageTotals;
  after: UsageTotals;
  /** Over the new events only. */
  inserted: UsageTotals;
}

const DEFAULT_PAGE_SIZE = 50;

const EVENT_FIELDS = [
  "provider",
  "model",
  "stream",
  "finishReason",
  "latencyMs",
  "inputTokens",
  "outputTokens",
  "cachedTokens",
  "reasoningTokens",
  "costUsd",
  "payload",
  "categorizerVersion",
] as const satisfies ReadonlyArray<keyof EventWithMetric["event"]>;

const METRIC_FIELDS = [
  "tokensByCategory",
  "splits",
  "toolsByName",
  "toolsTotalCount",
  "toolsUsedCount",
  "inputTokens",
  "outputTokens",
  "costUsd",
  "latencyMs",
  "categorizerVersion",
] as const satisfies ReadonlyArray<keyof EventWithMetric["metric"]>;

/**
 * Read the project's stored trace exports in the window, oldest first, one
 * bounded batch at a time. Each batch is planned against storage and, with
 * `apply`, written before the next batch is read. A dry run writes nothing.
 */
export async function reprocessOtlpRawExports(
  options: ReprocessOptions,
  deps: ReprocessDeps,
): Promise<ReprocessReport> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const report = emptyReport(options.apply);
  let after: OtlpRawExportBody | undefined;
  for (;;) {
    const page = await deps.readPage(after, pageSize);
    const rebuilt: EventWithMetric[] = [];
    for (const row of page) {
      report.exports += 1;
      if (row.signal !== "traces") {
        report.skippedLogExports += 1;
        continue;
      }
      const spans = decodeStoredExport(row);
      if (!spans) {
        report.undecodableExports += 1;
        continue;
      }
      report.spans += spans.length;
      rebuilt.push(...(await rebuildEventRows(options.projectId, spans, deps.flags)));
    }

    const unique = uniqueByDedupeHash(rebuilt);
    if (unique.length > 0) {
      const stored = await deps.findStoredEvents(storedEventKeys(unique));
      const plan = planReprocess(unique, stored);
      addToReport(report, unique.length, plan);
      if (options.apply && (plan.updates.length > 0 || plan.inserts.length > 0)) {
        await deps.applyPlan(plan);
      }
    }
    deps.onBatch?.(report);

    if (page.length < pageSize) return report;
    after = page[page.length - 1];
  }
}

/**
 * The event rows ingest would derive from these spans today: the same passes,
 * in the same order, as `persistDecodedSpans`. It mutates `spans`.
 */
export async function rebuildEventRows(
  projectId: string,
  spans: Parameters<typeof groupSpans>[0],
  flags: ReprocessIngestFlags,
): Promise<EventWithMetric[]> {
  normalizeAiSdkSpans(spans);
  normalizeSemconvAliases(spans);
  const dedupe = await resolveAgentSpanDedupe(spans, projectId, flags.agentSpanDedupe, (err) => {
    throw err;
  });
  return toRows(
    projectId,
    groupSpans(spans, dedupe),
    { captureReply: flags.captureReply },
    flags.prices,
  );
}

/** Compare rebuilt rows with stored ones: what to patch, what to insert, what already agrees. */
export function planReprocess(rebuilt: EventWithMetric[], stored: StoredEvent[]): ReprocessPlan {
  const byKey = new Map<string, StoredEvent>();
  for (const row of stored) {
    if (row.dedupeHash) byKey.set(`hash:${row.dedupeHash}`, row);
    if (row.traceId && row.spanId) byKey.set(spanKey(row.traceId, row.spanId), row);
  }
  const plan: ReprocessPlan = { updates: [], inserts: [], unchanged: 0, conflicting: 0 };
  for (const row of rebuilt) {
    const found = rowKeys(row)
      .map((key) => byKey.get(key))
      .filter((stored) => stored !== undefined);
    const match = found.find((stored) => sameTrace(stored, row));
    if (!match) {
      if (found.length > 0) plan.conflicting += 1;
      else plan.inserts.push(row);
      continue;
    }
    const event = pick(row.event, EVENT_FIELDS);
    const metric = pick(row.metric, METRIC_FIELDS);
    if (sameFields(match.event, event) && match.metric && sameFields(match.metric, metric)) {
      plan.unchanged += 1;
      continue;
    }
    plan.updates.push({ eventId: match.id, before: match.event, event, metric: row.metric });
  }
  return plan;
}

/** The keys a reprocess looks stored events up by, for a batch of rebuilt rows. */
export function storedEventKeys(rows: EventWithMetric[]): StoredEventKeys {
  const dedupeHashes = new Set<string>();
  const traceIds = new Set<string>();
  for (const { event } of rows) {
    if (event.dedupeHash) dedupeHashes.add(event.dedupeHash);
    if (event.spanId) dedupeHashes.add(spanIdHash(event.spanId));
    if (event.traceId && event.spanId) traceIds.add(event.traceId);
  }
  return { dedupeHashes: [...dedupeHashes], traceIds: [...traceIds] };
}

function decodeStoredExport(row: OtlpRawExportBody): Parameters<typeof groupSpans>[0] | null {
  try {
    return decodeOtlp(row.contentType, new Uint8Array(gunzipSync(row.body)));
  } catch {
    return null;
  }
}

function uniqueByDedupeHash(rows: EventWithMetric[]): EventWithMetric[] {
  const byHash = new Map<string, EventWithMetric>();
  for (const row of rows) {
    const hash = row.event.dedupeHash;
    if (hash && !byHash.has(hash)) byHash.set(hash, row);
  }
  return [...byHash.values()];
}

function rowKeys({ event }: EventWithMetric): string[] {
  const keys: string[] = [];
  if (event.dedupeHash) keys.push(`hash:${event.dedupeHash}`);
  if (event.spanId) keys.push(`hash:${spanIdHash(event.spanId)}`);
  if (event.traceId && event.spanId) keys.push(spanKey(event.traceId, event.spanId));
  return keys;
}

function sameTrace(stored: StoredEvent, { event }: EventWithMetric): boolean {
  return stored.traceId === null || !event.traceId || stored.traceId === event.traceId;
}

function spanKey(traceId: string, spanId: string): string {
  return `span:${traceId}/${spanId}`;
}

/** The dedupe hash `otlpDedupeHash` gives a call with no response id. */
function spanIdHash(spanId: string): string {
  return createHash("sha256").update(spanId).digest("hex");
}

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = source[key];
  return out;
}

function sameFields(stored: object, rebuilt: object): boolean {
  return canonical(stored) === canonical(rebuilt);
}

/**
 * A stable string of a row as Postgres would store it: jsonb drops undefined
 * and reorders keys, numeric(12,6) rounds the cost, and an absent value is null.
 */
function canonical(value: object): string {
  const normalized: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    normalized[key] = key === "costUsd" ? roundedCost(field) : jsonValue(field);
  }
  return stableStringify(normalized);
}

function roundedCost(value: unknown): string | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(6) : null;
}

function jsonValue(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function emptyReport(applied: boolean): ReprocessReport {
  return {
    applied,
    exports: 0,
    skippedLogExports: 0,
    undecodableExports: 0,
    spans: 0,
    rebuiltEvents: 0,
    unchangedEvents: 0,
    changedEvents: 0,
    newEvents: 0,
    conflictingEvents: 0,
    before: emptyTotals(),
    after: emptyTotals(),
    inserted: emptyTotals(),
  };
}

function emptyTotals(): UsageTotals {
  return { events: 0, inputTokens: 0, cachedTokens: 0, costUsd: 0 };
}

function addToReport(report: ReprocessReport, rebuilt: number, plan: ReprocessPlan): void {
  report.rebuiltEvents += rebuilt;
  report.unchangedEvents += plan.unchanged;
  report.changedEvents += plan.updates.length;
  report.newEvents += plan.inserts.length;
  report.conflictingEvents += plan.conflicting;
  for (const update of plan.updates) {
    addUsage(report.before, update.before);
    addUsage(report.after, update.event);
  }
  for (const row of plan.inserts) addUsage(report.inserted, row.event);
}

function addUsage(totals: UsageTotals, event: PatchableEvent): void {
  totals.events += 1;
  totals.inputTokens += event.inputTokens ?? 0;
  totals.cachedTokens += event.cachedTokens ?? 0;
  totals.costUsd += Number(event.costUsd ?? 0);
}
