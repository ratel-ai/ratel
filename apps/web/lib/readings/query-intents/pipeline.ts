/**
 * Phase 3 orchestration: turn the raw search queries already streaming into
 * `trace_events` (Phase 1) into the deduped "recurring asks" ledger
 * (`query_intents` / `query_intent_occurrences`), windowed by a per-project
 * watermark so on-demand triggers and the hourly cron drain never double-process
 * the same query. Tool Explorer reads the ledger for its asks.
 *
 * Each search event is one intent unit, its raw query, resolved in two steps:
 *   1. exact-match — literal repeats, keyed by the same normalization
 *      `project_intents` already uses (`./normalize.ts`).
 *   2. a pluggable {@link Clusterer} for everything fuzzier than a literal repeat —
 *      the default {@link JaccardClusterer} is free, deterministic, and offline; the
 *      seam lets a different clustering method drop in without touching the pipeline.
 *
 * Every collaborator is injected (dependency-injected), so the whole
 * pipeline is unit-testable without a database or a live model/service call.
 */

import { type Clusterer, jaccardClusterer } from "@/lib/readings/query-intents/clusterer";
import { normalizeIntent } from "@/lib/readings/query-intents/normalize";
import { resolveCanonicals } from "@/lib/readings/query-intents/resolve-canonicals";

/** One raw query occurrence read from `trace_events` (search / skill_search /
 * gateway_search types — i.e. any `search_capabilities` call, direct-SDK or MCP). */
export interface RawQueryEvent {
  /** The source trace_events row id — provenance + the occurrence ledger's idempotency key. */
  id: string;
  query: string;
  occurredAt: Date;
  sessionId: string | null;
  endUserId: string | null;
}

/** A project's existing canonical query intent, as read for matching. */
export interface ExistingCanonical {
  id: string;
  normalizedText: string;
  text: string;
  /** Accumulated member phrases (see `query_intents.member_text`); optional so
   * callers that only need exact-match can omit it. */
  memberText?: string;
}

/** One occurrence resolved to its canonical — what gets persisted. */
export interface ResolvedOccurrence {
  traceEventId: string;
  /** Which intent of the source event this is (0-based). Always 0: one search
   * event is one intent unit. Composite
   * idempotency key with `traceEventId`. */
  intentIndex: number;
  query: string;
  occurredAt: Date;
  sessionId: string | null;
  endUserId: string | null;
  normalizedText: string;
  canonicalText: string;
  /** The phrase that was clustered (the raw query), accumulated into the
   * canonical's `member_text` so the BM25 clusterer sees the cluster's whole
   * vocabulary. */
  intentText: string;
}

export interface QueryIntentsDeps {
  /** The project's watermark — the latest event time already categorized; null before the first run. */
  getWatermark: (projectId: string) => Promise<Date | null>;
  /** Search-type trace_events with event time > `since` (or all, when null), oldest first. */
  listNewSearchEvents: (projectId: string, since: Date | null) => Promise<RawQueryEvent[]>;
  /**
   * Exact-match lookup for Pass 1: the existing canonicals whose `normalizedText`
   * is one of `normalizedTexts`. Must be EXHAUSTIVE (uncapped) — a literal repeat
   * has to find its canonical no matter how many the project has, or the same ask
   * fragments once the project grows past any seed cap.
   */
  lookupExactCanonicals: (
    projectId: string,
    normalizedTexts: string[],
  ) => Promise<ExistingCanonical[]>;
  /**
   * The clustering seeds for Pass 2. May be capped — fuzzy matching against unbounded
   * seeds isn't feasible anyway.
   */
  listExistingCanonicals: (projectId: string) => Promise<ExistingCanonical[]>;
  /**
   * The fuzzy-clustering strategy for everything past exact-match. Defaults to the
   * deterministic {@link jaccardClusterer} when omitted; inject a different
   * {@link Clusterer} to swap the method without touching the pipeline.
   */
  clusterer?: Clusterer;
  recordOccurrences: (
    projectId: string,
    occurrences: ResolvedOccurrence[],
  ) => Promise<{ intentsCreated: number; occurrencesAdded: number }>;
  advanceWatermark: (projectId: string, through: Date) => Promise<void>;
}

export interface CategorizeRunResult {
  /** How many raw query events this run read (0 = nothing new since the watermark). */
  processed: number;
  intentsCreated: number;
  occurrencesAdded: number;
  /** Always false: the optional extraction stage is gone. Kept so a job's
   * stored result reads the same as it always has. */
  usedExtractor: boolean;
}

/**
 * One (event, intent) unit flowing through the passes: exactly one per event,
 * `intentIndex 0` with `text` the raw query. `key` (`<eventId>#<idx>`) is the
 * unit's identity for the per-pass maps.
 */
interface QueryUnit {
  event: RawQueryEvent;
  intentIndex: number;
  /** The text clustered and persisted as canonical: the raw query. */
  text: string;
  key: string;
}

/** One unit's occurrence, resolved to its canonical. `query` stays the RAW source
 * phrasing (provenance) while the canonical comes from clustering the intent text. */
function toOccurrence(
  u: QueryUnit,
  normalizedText: string,
  canonicalText: string,
): ResolvedOccurrence {
  return {
    traceEventId: u.event.id,
    intentIndex: u.intentIndex,
    query: u.event.query,
    occurredAt: u.event.occurredAt,
    sessionId: u.event.sessionId,
    endUserId: u.event.endUserId,
    normalizedText,
    canonicalText,
    intentText: u.text,
  };
}

/** An event's unit: the raw query at index 0. */
function rawUnit(e: RawQueryEvent): QueryUnit {
  return { event: e, intentIndex: 0, text: e.query, key: `${e.id}#0` };
}

/**
 * Run one categorization pass for a project: read everything new since its
 * watermark, resolve each occurrence to a canonical ask (exact match, then
 * cluster), persist, and advance the watermark to the latest event time processed.
 *
 * If `recordOccurrences` throws, the watermark is NOT advanced — a retry (the next
 * on-demand trigger or cron tick) re-reads the same window. That's safe: occurrence
 * persistence is idempotent on `(trace_event_id, intent_index)` (a composite unique
 * index), so a partial or repeated write never double-counts.
 */
export async function categorizeProjectQueries(
  projectId: string,
  deps: QueryIntentsDeps,
): Promise<CategorizeRunResult> {
  const since = await deps.getWatermark(projectId);
  const events = await deps.listNewSearchEvents(projectId, since);
  if (events.length === 0) {
    return { processed: 0, intentsCreated: 0, occurrencesAdded: 0, usedExtractor: false };
  }

  const units = events.map(rawUnit);

  // Pass 1 (exact match, exhaustive) + Pass 2 (pluggable fuzzy clustering, default
  // Jaccard), through `resolveCanonicals`. Every unit sharing a normalized text gets the
  // same resolution; a candidate that matches nothing stands as its own canonical, so
  // an occurrence is never dropped.
  const normalizedOf = new Map<string, string>(); // unit key -> normalized text
  for (const u of units) normalizedOf.set(u.key, normalizeIntent(u.text));
  const canonicalByKey = await resolveCanonicals(
    projectId,
    units.map((u) => ({ key: normalizedOf.get(u.key)!, text: u.text })),
    {
      lookupExactCanonicals: deps.lookupExactCanonicals,
      listExistingCanonicals: deps.listExistingCanonicals,
      clusterer: deps.clusterer ?? jaccardClusterer,
    },
  );
  const resolved: ResolvedOccurrence[] = units.map((u) => {
    const canonical = canonicalByKey.get(normalizedOf.get(u.key)!)!;
    return toOccurrence(u, canonical.normalizedText, canonical.canonicalText);
  });

  const { intentsCreated, occurrencesAdded } = await deps.recordOccurrences(projectId, resolved);

  const maxOccurredAt = events.reduce(
    (m, e) => (e.occurredAt > m ? e.occurredAt : m),
    events[0].occurredAt,
  );
  await deps.advanceWatermark(projectId, maxOccurredAt);

  return { processed: events.length, intentsCreated, occurrencesAdded, usedExtractor: false };
}
