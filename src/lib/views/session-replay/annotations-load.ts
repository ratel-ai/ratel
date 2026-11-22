import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { eventMetrics, events, otelLogs } from "@/lib/ingest/otlp/schema";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { queryKey } from "@/lib/synthesis/match-quality/labels";
import { matchQualityLabels } from "@/lib/synthesis/match-quality/schema";
import {
  type Annotation,
  type AnnotationReason,
  annotateSession,
  type CalibrationMismatch,
} from "./annotations";
import { type Composition, composition, lensMarkers, type PayloadShape } from "./composition";
import type { ReplayDb } from "./load";
import type { SessionTimeline, TimelineStep } from "./timeline";

/**
 * The context lens and decision annotations of one session (RC-144), read for
 * a timeline `loadSessionTimeline` built (same project). Reads
 * `event_metrics`, sizes of the call payloads (measured in SQL), the
 * match-quality labels of the searches' queries and the calibration
 * mismatches of the session's traces.
 *
 * PRIVACY: payload text never leaves the database. A search's query text is
 * read only to compute its label key (`queryKey`), then dropped: the lens
 * holds counts, codes and ids.
 */

export interface LensCall {
  step: number;
  composition: Composition;
}

export interface SessionLens {
  calls: LensCall[];
  bloatStartStep: number | null;
  unusedTools: { step: number; tools: string[] }[];
  missingTools: { step: number; tools: string[] }[];
  annotations: Annotation[];
  /** What the lens cannot know. */
  gaps: ["no_window_size"];
}

const ID_CHUNK = 500;
const COMPARISON_EVENT = "ratel.experiment.comparison";
const EXACT_ORDER_KEY = "ratel.experiment.agreement.exact_order";
/** A comparison log lands within this of its search. */
const CALIBRATION_SLACK_MS = 60_000;
const logger = getLogger("session-replay");

const SYSTEM = sql`coalesce(${events.payload}->>'system', '')`;
const SKILL_BLOCKS = `(<skills>|<available_skills>|<skill[ >]).*?(</skills>|</available_skills>|</skill>)`;
const MEMORY_BLOCKS = `(<memory>|<memories>|<context>|<retrieved_context>).*?(</memory>|</memories>|</context>|</retrieved_context>)`;
const MESSAGES = sql`(case when jsonb_typeof(${events.payload}->'messages') = 'array' then ${events.payload}->'messages' else '[]'::jsonb end)`;
const SHAPE = {
  systemChars: sql<number>`length(${SYSTEM})::int`,
  skillChars: sql<number>`(length(${SYSTEM}) - length(regexp_replace(${SYSTEM}, ${SKILL_BLOCKS}, '', 'gi')))::int`,
  memoryChars: sql<number>`(length(${SYSTEM}) - length(regexp_replace(${SYSTEM}, ${MEMORY_BLOCKS}, '', 'gi')))::int`,
  toolResultChars: sql<number>`(select coalesce(sum(length(m->>'content')), 0) from jsonb_array_elements(${MESSAGES}) m where m->>'role' = 'tool')::int`,
  messageChars: sql<number>`(select coalesce(sum(case jsonb_typeof(m->'content')
      when 'string' then length(m->>'content')
      when 'array' then (select coalesce(sum(length(coalesce(b->>'text', b->>'arguments', ''))), 0) from jsonb_array_elements(m->'content') b)
      else 0 end), 0) from jsonb_array_elements(${MESSAGES}) m)::int`,
};

export async function loadSessionLens(
  projectId: string,
  timeline: SessionTimeline,
  db: ReplayDb = getDb(),
): Promise<SessionLens> {
  const callSteps = timeline.steps.filter(
    (step): step is Extract<TimelineStep, { kind: "model_call" }> => step.kind === "model_call",
  );
  const searchSteps = timeline.steps.filter(
    (step): step is Extract<TimelineStep, { kind: "search" }> => step.kind === "search",
  );
  const [compositions, searchEvents] = await Promise.all([
    loadCompositions(
      projectId,
      callSteps.map((step) => step.eventId),
      db,
    ),
    loadSearchEvents(
      projectId,
      searchSteps.map((step) => step.traceEventId),
      db,
    ),
  ]);
  const [labels, calibrationMismatches] = await Promise.all([
    loadLabels(projectId, searchSteps, searchEvents, db),
    loadCalibrationMismatches(projectId, searchSteps, searchEvents, db),
  ]);

  const usedTools = new Set<string>();
  for (const step of timeline.steps)
    if (step.kind === "tool_call" && step.targetId) usedTools.add(step.targetId);
  for (const c of compositions.values())
    for (const tool of c.loadedTools) if (tool.calls > 0) usedTools.add(tool.name);
  const calls = callSteps.flatMap((step) => {
    const c = compositions.get(step.eventId);
    return c ? [{ step: step.index, composition: c }] : [];
  });
  const stepOfEvent = new Map(calls.map((call) => [call.composition.eventId, call.step]));
  const markers = lensMarkers(
    calls.map((call) => call.composition),
    usedTools,
  );
  const { annotations, missingTools } = annotateSession({
    timeline,
    compositions,
    labels,
    calibrationMismatches,
  });

  const lens: SessionLens = {
    calls,
    bloatStartStep: markers.bloatStart ? (stepOfEvent.get(markers.bloatStart) ?? null) : null,
    unusedTools: Object.entries(markers.unusedTools)
      .filter(([, tools]) => tools.length > 0)
      .map(([eventId, tools]) => ({ step: stepOfEvent.get(eventId)!, tools }))
      .sort((a, b) => a.step - b.step),
    missingTools,
    annotations,
    gaps: ["no_window_size"],
  };
  logger.info({ project_id: projectId, ...lensCounts(lens) }, "session_replay_lens_built");
  return lens;
}

/** Counts only, for the log line: model calls, markers and one count per annotation code. */
export function lensCounts(lens: SessionLens): Record<string, number | boolean> {
  const byCode: Partial<Record<`annotation_${AnnotationReason}`, number>> = {};
  for (const annotation of lens.annotations)
    byCode[`annotation_${annotation.reason}`] =
      (byCode[`annotation_${annotation.reason}`] ?? 0) + 1;
  return {
    model_calls: lens.calls.length,
    calls_with_unused_tools: lens.unusedTools.length,
    calls_with_missing_tools: lens.missingTools.length,
    bloat: lens.bloatStartStep !== null,
    ...byCode,
  };
}

async function loadCompositions(
  projectId: string,
  eventIds: readonly string[],
  db: ReplayDb,
): Promise<Map<string, Composition>> {
  const out = new Map<string, Composition>();
  for (let i = 0; i < eventIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        eventId: eventMetrics.eventId,
        inputTokens: eventMetrics.inputTokens,
        tokensByCategory: eventMetrics.tokensByCategory,
        splits: eventMetrics.splits,
        toolsByName: eventMetrics.toolsByName,
        ...SHAPE,
      })
      .from(eventMetrics)
      .innerJoin(events, eq(events.id, eventMetrics.eventId))
      .where(
        and(
          eq(eventMetrics.projectId, projectId),
          eq(events.projectId, projectId),
          inArray(eventMetrics.eventId, eventIds.slice(i, i + ID_CHUNK)),
        ),
      );
    for (const row of rows) {
      const shape: PayloadShape = {
        systemBaseChars: Math.max(0, row.systemChars - row.skillChars - row.memoryChars),
        skillChars: row.skillChars,
        toolResultChars: row.toolResultChars,
        messageChars: row.messageChars,
      };
      out.set(
        row.eventId,
        composition({
          eventId: row.eventId,
          inputTokens: row.inputTokens,
          tokensByCategory: row.tokensByCategory,
          splits: row.splits,
          toolsByName: row.toolsByName ?? {},
          shape,
        }),
      );
    }
  }
  return out;
}

interface SearchEvent {
  traceId: string | null;
  occurredAt: Date | null;
  /** The label key of the search's query; the query itself is dropped here. */
  key: string | null;
}

async function loadSearchEvents(
  projectId: string,
  eventIds: readonly string[],
  db: ReplayDb,
): Promise<Map<string, SearchEvent>> {
  const out = new Map<string, SearchEvent>();
  for (let i = 0; i < eventIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        id: traceEvents.id,
        traceId: traceEvents.traceId,
        occurredAt: traceEvents.occurredAt,
        query: traceEvents.query,
      })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          inArray(traceEvents.id, eventIds.slice(i, i + ID_CHUNK)),
        ),
      );
    for (const row of rows)
      out.set(row.id, {
        traceId: row.traceId,
        occurredAt: row.occurredAt,
        key: queryKey(row.query),
      });
  }
  return out;
}

/** The labelled tool by search step, for the searches whose query has a decided label. */
async function loadLabels(
  projectId: string,
  searches: readonly Extract<TimelineStep, { kind: "search" }>[],
  searchEvents: ReadonlyMap<string, SearchEvent>,
  db: ReplayDb,
): Promise<Map<number, string>> {
  const keys = [
    ...new Set(
      searches
        .map((step) => searchEvents.get(step.traceEventId)?.key)
        .filter((key): key is string => !!key),
    ),
  ];
  const entryByKey = new Map<string, string>();
  for (let i = 0; i < keys.length; i += ID_CHUNK) {
    const rows = await db
      .select({ key: matchQualityLabels.queryKey, entryId: matchQualityLabels.entryId })
      .from(matchQualityLabels)
      .where(
        and(
          eq(matchQualityLabels.projectId, projectId),
          inArray(matchQualityLabels.queryKey, keys.slice(i, i + ID_CHUNK)),
          ne(matchQualityLabels.source, "unclear"),
          ne(matchQualityLabels.entryId, ""),
        ),
      );
    for (const row of rows) entryByKey.set(row.key, row.entryId);
  }
  const out = new Map<number, string>();
  for (const step of searches) {
    const key = searchEvents.get(step.traceEventId)?.key;
    const entry = key ? entryByKey.get(key) : undefined;
    if (entry) out.set(step.index, entry);
  }
  return out;
}

/** Comparison logs on the searches' traces whose arms disagreed on order, each given to the nearest search of its trace. */
async function loadCalibrationMismatches(
  projectId: string,
  searches: readonly Extract<TimelineStep, { kind: "search" }>[],
  searchEvents: ReadonlyMap<string, SearchEvent>,
  db: ReplayDb,
): Promise<CalibrationMismatch[]> {
  const byTrace = new Map<string, { step: number; at: number }[]>();
  for (const step of searches) {
    const event = searchEvents.get(step.traceEventId);
    if (!event?.traceId) continue;
    const at = (event.occurredAt ?? new Date(step.at)).getTime();
    byTrace.set(event.traceId, [...(byTrace.get(event.traceId) ?? []), { step: step.index, at }]);
  }
  const traceIds = [...byTrace.keys()];
  if (traceIds.length === 0) return [];
  const times = [...byTrace.values()].flat().map((search) => search.at);
  const out: CalibrationMismatch[] = [];
  for (let i = 0; i < traceIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        traceId: otelLogs.traceId,
        occurredAt: otelLogs.occurredAt,
        selectionId: otelLogs.experimentSelectionId,
      })
      .from(otelLogs)
      .where(
        and(
          eq(otelLogs.projectId, projectId),
          eq(otelLogs.eventName, COMPARISON_EVENT),
          inArray(otelLogs.traceId, traceIds.slice(i, i + ID_CHUNK)),
          gte(otelLogs.occurredAt, new Date(Math.min(...times) - CALIBRATION_SLACK_MS)),
          lte(otelLogs.occurredAt, new Date(Math.max(...times) + CALIBRATION_SLACK_MS)),
          sql`jsonb_typeof(${otelLogs.experimentAttrs} -> ${EXACT_ORDER_KEY}) = 'boolean' and (${otelLogs.experimentAttrs} ->> ${EXACT_ORDER_KEY})::boolean = false`,
        ),
      );
    for (const row of rows) {
      const candidates = byTrace.get(row.traceId ?? "") ?? [];
      const at = row.occurredAt.getTime();
      const nearest = [...candidates].sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
      if (nearest && Math.abs(nearest.at - at) <= CALIBRATION_SLACK_MS)
        out.push({ step: nearest.step, selectionId: row.selectionId });
    }
  }
  return out;
}
