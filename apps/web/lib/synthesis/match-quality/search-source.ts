import { and, asc, desc, eq, exists, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { traceEventHits, traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";
import type { ExperimentWindow } from "@/lib/synthesis/experiments/service";
import type { EvaluableSelection } from "@/lib/synthesis/quality/ground-truth";
import {
  listQualityCalibrations,
  loadEvaluableSelections,
  MAX_SELECTIONS,
  type QualitySelections,
  withAnswers,
} from "@/lib/synthesis/quality/queries";
import { isSearchTelemetry, SEARCH_TELEMETRY_ARM, SEARCH_TELEMETRY_SOURCE } from "./source-name";

/**
 * Match quality without a calibration.
 *
 * A calibration (a shadow experiment against the customer's old search) used to
 * be required, because the old engine's first result stood in for the right
 * answer. It no longer does: the answer key decides the right tool from the
 * search text alone. So every project whose SDK records its searches (query
 * text plus the ranked hits it returned) can be measured, judged, tuned and
 * backtested, with Ratel as the only engine. A calibration, when one exists,
 * still wins: it adds the old engine as a number beside ours.
 *
 * The source travels as a run's `experimentName`: a calibration's own name, or
 * {@link SEARCH_TELEMETRY_SOURCE} for plain search telemetry.
 */

export { isSearchTelemetry, SEARCH_TELEMETRY_ARM, SEARCH_TELEMETRY_SOURCE } from "./source-name";

const SEARCH_TYPE = "search";

type Db = Pick<ReturnType<typeof getDb>, "select">;

/** Where a project's match quality comes from in a window, or null when nothing is recorded. */
export async function resolveEvidenceSource(
  projectId: string,
  window: ExperimentWindow,
  db: Db = getDb(),
): Promise<{ experimentName: string; count: number } | null> {
  const [busiest] = await listQualityCalibrations(projectId, window, db);
  if (busiest) return { experimentName: busiest.experimentName, count: busiest.comparisonCount };
  const count = await countCapturedSearches(projectId, window, db);
  return count > 0 ? { experimentName: SEARCH_TELEMETRY_SOURCE, count } : null;
}

/** Searches with their query text captured, in a window. */
export async function countCapturedSearches(
  projectId: string,
  window: ExperimentWindow,
  db: Db = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.type, SEARCH_TYPE),
        isNotNull(traceEvents.query),
        gte(traceEvents.occurredAt, window.since),
        lt(traceEvents.occurredAt, window.until),
      ),
    );
  return row?.n ?? 0;
}

/** Per-window counts of captured searches, for the run controls' window picker. */
export async function countCapturedSearchesPerWindow(
  projectId: string,
  windows: readonly number[],
  db: Db = getDb(),
  now: number = Date.now(),
): Promise<{ counts: Map<number, number>; earliest: Date | null }> {
  const counts = new Map<number, number>();
  if (windows.length === 0) return { counts, earliest: null };
  const longest = Math.max(...windows);
  const rows = await db
    .select({ occurredAt: traceEvents.occurredAt })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.type, SEARCH_TYPE),
        isNotNull(traceEvents.query),
        gte(traceEvents.occurredAt, new Date(now - longest * 86_400_000)),
      ),
    );
  let earliest: Date | null = null;
  const times = rows.map((row) => {
    const at = toDate(row.occurredAt);
    if (earliest === null || at < earliest) earliest = at;
    return at.getTime();
  });
  for (const days of windows) {
    const since = now - days * 86_400_000;
    counts.set(days, times.filter((time) => time >= since).length);
  }
  return { counts, earliest };
}

/**
 * Every project with captured searches in a window: sweep candidates without a
 * calibration.
 *
 * Asked per project, so Postgres ranges on trace_events_project_type_time_idx
 * (project_id, type, coalesce(occurred_at, received_at)) and stops at the first
 * search. A single GROUP BY over trace_events had no index to use (every one
 * leads with project_id), so each drain tick read the whole table
 * (2026-10-28, RC-28). The coalesce bounds are only there for the index;
 * occurred_at decides, as before.
 */
export async function listSearchTelemetryProjects(
  window: ExperimentWindow,
  db: Db = getDb(),
): Promise<string[]> {
  const eventTime = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
  const rows = await db
    .select({ projectId: projects.id })
    .from(projects)
    .where(
      exists(
        db
          .select({ one: sql`1` })
          .from(traceEvents)
          .where(
            and(
              eq(traceEvents.projectId, projects.id),
              eq(traceEvents.type, SEARCH_TYPE),
              gte(eventTime, window.since),
              lt(eventTime, window.until),
              isNotNull(traceEvents.query),
              gte(traceEvents.occurredAt, window.since),
              lt(traceEvents.occurredAt, window.until),
            ),
          ),
      ),
    );
  return rows.map((row) => row.projectId);
}

/**
 * A window's captured searches as single-engine selections, answer key attached.
 *
 * One selection per `search` event with its query text: Ratel's ranked tool
 * hits are the only arm, and it served. The selection id is the SDK's
 * `search_id` when it sent one, so the invocation lane can link the tool the
 * agent then ran; otherwise the event's own id. Searches without query text
 * are skipped: there is nothing to judge.
 */
export async function loadSearchSelections(
  projectId: string,
  window: ExperimentWindow,
  db: Db = getDb(),
  limit: number = MAX_SELECTIONS,
): Promise<QualitySelections> {
  const events = await db
    .select({
      id: traceEvents.id,
      searchId: traceEvents.searchId,
      occurredAt: traceEvents.occurredAt,
      query: traceEvents.query,
    })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.type, SEARCH_TYPE),
        isNotNull(traceEvents.query),
        gte(traceEvents.occurredAt, window.since),
        lt(traceEvents.occurredAt, window.until),
      ),
    )
    .orderBy(desc(traceEvents.occurredAt))
    .limit(limit + 1);

  const truncated = events.length > limit;
  const kept = events.slice(0, limit);
  const hits = new Map<string, string[]>();
  for (let offset = 0; offset < kept.length; offset += 1000) {
    const ids = kept.slice(offset, offset + 1000).map((event) => event.id);
    if (ids.length === 0) continue;
    const rows = await db
      .select({ eventId: traceEventHits.traceEventId, targetId: traceEventHits.targetId })
      .from(traceEventHits)
      .where(and(inArray(traceEventHits.traceEventId, ids), eq(traceEventHits.targetType, "tool")))
      .orderBy(asc(traceEventHits.traceEventId), asc(traceEventHits.rank));
    for (const row of rows) {
      const list = hits.get(row.eventId) ?? [];
      list.push(row.targetId);
      hits.set(row.eventId, list);
    }
  }

  const selections: EvaluableSelection[] = kept
    .map((event) => ({
      selectionId: event.searchId ?? event.id,
      occurredAt: toDate(event.occurredAt),
      query: event.query,
      invokedToolId: null,
      invokedRank: null,
      arms: [
        {
          arm: SEARCH_TELEMETRY_ARM,
          role: "serving" as const,
          resultIds: hits.get(event.id) ?? [],
        },
      ],
    }))
    .reverse();

  const answered = await withAnswers(projectId, selections, db);
  return {
    selections: answered,
    diagnostics: {
      comparisonCount: answered.length,
      selectionCount: answered.length,
      invocationCount: 0,
      recordedRankCount: 0,
      attributionMode: "none",
      rankedSelectionCount: answered.filter((selection) => selection.arms[0]!.resultIds.length > 0)
        .length,
      invokedToolKey: null,
      truncated,
    },
  };
}

/** Rows are filtered on `occurred_at`, so it is present; the column is nullable. */
function toDate(value: Date | string | null): Date {
  return value instanceof Date ? value : new Date(value ?? 0);
}

/** The selections for a run's source: a calibration, or plain search telemetry. */
export function loadSourceSelections(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: Db = getDb(),
): Promise<QualitySelections> {
  return isSearchTelemetry(experimentName)
    ? loadSearchSelections(projectId, window, db)
    : loadEvaluableSelections(projectId, experimentName, window, db);
}
