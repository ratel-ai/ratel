import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import {
  type BoundReadDb,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import type { IntentGraphDocument } from "@/lib/readings/intent-types/wire";
import { traceSignalRuns } from "@/lib/readings/trace-signals/schema";
import { createClusterClassifier } from "@/lib/views/intents/map/classify";
import type { AskOutcome } from "@/lib/views/intents/map/map-model";
import { type OutcomeSearch, scoreAskOutcomes } from "@/lib/views/intents/map/outcomes";
import type { ToolStep } from "@/lib/views/intents/map/tool-network";
import { mapSeams } from "./seams";

/** How far back a group's first-result rate reads: the window the shadow turns keep. */
export const ASK_OUTCOME_WINDOW_DAYS = 30;
/** The newest searches in the window one reading attributes, at most. */
export const ASK_OUTCOME_SEARCH_CAP = 2_000;
/** Attribution stops after this long, and the counts cover the searches it reached. */
export const ASK_OUTCOME_BUDGET_MS = 1_500;

export interface AskOutcomesResult {
  outcomes: AskOutcome[];
  /** Searches in the window that ran a tool, as read (at most the cap). */
  searches: number;
  /** True when the window held more of them than the reading attributed. */
  capped: boolean;
}

const logger = getLogger("intent-graph/ask-outcomes");
const HOUR_MS = 3_600_000;
const CACHE_LIMIT = 64;
/** One reading per graph revision and hour: a new fold or the next hour reads again. */
const cache = new Map<string, AskOutcomesResult>();

export function resetAskOutcomeCache(): void {
  cache.clear();
}

/**
 * Per ask group, how often the first result a search served was the tool the
 * agent ran next (`scoreAskOutcomes`), over the graph's searches in the last
 * 30 days that ran a tool, newest first and at most `ASK_OUTCOME_SEARCH_CAP`.
 * Each search is attributed to its group by the SDK's own matcher
 * (`createClusterClassifier`), so a group's count covers every search worded
 * its way, not only its stored phrasings. A search whose list a Cloud graph
 * ranked (live, or the runtime's own report, on any Cloud graph of the
 * project) is counted apart and not scored.
 *
 * Bounded: one statement timeout over its two reads, a cap on searches and a
 * time budget on attribution. Queries and members are raw user text; they stay
 * inside this function and only counts per group id leave it.
 */
export async function loadAskOutcomes(
  input: {
    projectId: string;
    graphKey: string;
    /** The graph's revision: a new fold is a new reading. */
    rev: number;
    /** The groups to return, typically the ones drawn or listed. */
    keep: ReadonlySet<string>;
    /** Every Cloud-built graph of the project. */
    cloudGraphKeys: readonly string[];
    now?: Date;
  },
  db: BoundReadDb = getDb(),
): Promise<AskOutcomesResult> {
  const now = input.now ?? new Date();
  const hour = Math.floor(now.getTime() / HOUR_MS);
  const key = `${input.projectId}|${input.graphKey}|${input.rev}|${hour}`;
  const cached = cache.get(key) ?? (await readOutcomes(input, hour, db));
  if (!cache.has(key)) {
    cache.set(key, cached);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  return {
    ...cached,
    outcomes: cached.outcomes.filter((outcome) => input.keep.has(outcome.clusterId)),
  };
}

async function readOutcomes(
  input: { projectId: string; graphKey: string; cloudGraphKeys: readonly string[] },
  hour: number,
  db: BoundReadDb,
): Promise<AskOutcomesResult> {
  const since = new Date(hour * HOUR_MS - ASK_OUTCOME_WINDOW_DAYS * 86_400_000).toISOString();
  const { projectId, graphKey } = input;
  const { document, searches } = await withStatementTimeout(
    async (tx) => {
      const graph = await tx.execute<{ document: IntentGraphDocument }>(sql`
        select document from intent_graphs where project_id = ${projectId} and graph_key = ${graphKey}
      `);
      const keys = input.cloudGraphKeys.length > 0 ? input.cloudGraphKeys : [graphKey];
      const rows = await tx.execute<{
        query: string;
        invoked_tool_id: string;
        first_tool_id: string | null;
        shaped: boolean;
      }>(sql`
        with turns as (
          select s.search_event_id, s.invoked_tool_id, (s.live or s.reported) as shaped
            from intent_graph_shadow_turns s
           where s.project_id = ${projectId}
             and s.graph_key = ${graphKey}
             and s.occurred_at >= ${since}::timestamptz
             and s.invoked_tool_id is not null
           order by s.occurred_at desc
           limit ${ASK_OUTCOME_SEARCH_CAP + 1}
        )
        select e.query,
               t.invoked_tool_id,
               h.target_id as first_tool_id,
               (t.shaped or exists (
                  select 1
                    from intent_graph_shadow_turns x
                   where x.project_id = ${projectId}
                     and x.graph_key in (${sql.join(
                       keys.map((graph) => sql`${graph}`),
                       sql`, `,
                     )})
                     and x.search_event_id = t.search_event_id
                     and (x.live or x.reported)
               )) as shaped
          from turns t
          join trace_events e on e.project_id = ${projectId} and e.id = t.search_event_id
          left join trace_event_hits h
            on h.project_id = ${projectId}
           and h.trace_event_id = t.search_event_id
           and h.rank = 0
           and h.target_type = 'tool'
         where e.query is not null
      `);
      return { document: graph.rows[0]?.document ?? null, searches: rows.rows };
    },
    { operation: "intent_graph_ask_outcomes", timeoutMs: supplementaryReadTimeoutMs(), db },
  );
  if (!document) return { outcomes: [], searches: 0, capped: false };

  const classifier = createClusterClassifier(document);
  if (classifier.error) {
    logger.error(
      { err: classifier.error, project_id: projectId, graph_key: graphKey },
      "ask group matcher unavailable, matched by phrasing",
    );
    reportServerException(classifier.error, `project:${projectId}`, {
      operation: "intent_graph_ask_classifier",
      graph_key: graphKey,
    });
  }
  const read = searches.slice(0, ASK_OUTCOME_SEARCH_CAP);
  const scored = scoreAskOutcomes(
    read.map(
      (row): OutcomeSearch => ({
        query: row.query,
        invokedToolId: row.invoked_tool_id,
        firstToolId: row.first_tool_id,
        shaped: Boolean(row.shaped),
      }),
    ),
    classifier.clusterOf,
    { deadline: performance.now() + ASK_OUTCOME_BUDGET_MS },
  );
  return {
    outcomes: scored.outcomes,
    searches: scored.classified,
    capped: searches.length > ASK_OUTCOME_SEARCH_CAP || scored.classified < read.length,
  };
}

/**
 * Which tool came right after which in one turn, as steps between the tools in `keep` (the ones
 * on the map). Read from the tool explorer's latest run once it lands (`mapSeams.loadToolSteps`);
 * until then the map draws no "came next" arrows. Tool ids only; no query text is read.
 */
export async function loadToolSteps(
  input: { projectId: string; keep: ReadonlySet<string> },
  db: BoundReadDb = getDb(),
): Promise<ToolStep[]> {
  if (!mapSeams.loadToolSteps) return [];
  return mapSeams.loadToolSteps(input, db);
}

/** A task and the tools in its steps, in order (catalog ids, or `skill:<id>`). */
export interface TaskSteps {
  id: string;
  runs: number;
  steps: string[];
}

/**
 * The tasks of the latest completed task reading (Agent health's `workflows`
 * summary) with the tools in their steps, in order: what the Tools lens needs
 * to give every tool a home and to tell a tool many tasks share. One indexed
 * read of one row under the supplementary statement timeout. Tool ids only.
 */
export async function loadTaskSteps(
  projectId: string,
  db: BoundReadDb = getDb(),
): Promise<TaskSteps[]> {
  const rows = await withStatementTimeout(
    (tx) =>
      tx
        .select({ items: sql<unknown>`${traceSignalRuns.summary} -> 'workflows' -> 'items'` })
        .from(traceSignalRuns)
        .where(
          and(eq(traceSignalRuns.projectId, projectId), eq(traceSignalRuns.status, "completed")),
        )
        .orderBy(desc(traceSignalRuns.createdAt))
        .limit(1),
    { operation: "intent_map_task_steps", timeoutMs: supplementaryReadTimeoutMs(), db },
  );
  return parseTaskSteps(rows[0]?.items);
}

/** Stored JSON is untrusted: a task without an id or a run count is left out, and a step that is not a string too. */
export function parseTaskSteps(items: unknown): TaskSteps[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): TaskSteps[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as { id?: unknown; runs?: unknown; typicalOrder?: unknown };
    if (
      typeof record.id !== "string" ||
      typeof record.runs !== "number" ||
      !Number.isFinite(record.runs)
    )
      return [];
    const steps = Array.isArray(record.typicalOrder)
      ? record.typicalOrder.filter(
          (tool): tool is string => typeof tool === "string" && tool !== "",
        )
      : [];
    return [{ id: record.id, runs: record.runs, steps: [...new Set(steps)] }];
  });
}
