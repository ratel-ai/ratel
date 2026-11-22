import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { otelTraceSummaries } from "@/lib/synthesis/traces/schema";
import { loadRuns } from "@/lib/views/eval-gate/runs";
import { recordedView } from "@/lib/views/eval-gate/simulate";
import type { RunRecord } from "@/lib/views/eval-gate/types";
import { scoreRun } from "@/lib/views/task-scorers/engine";
import { scorersFor } from "@/lib/views/task-scorers/store";
import type { Scorer } from "@/lib/views/task-scorers/types";
import type { HealthKind, SampledTrace, VariantSample } from "@/lib/views/variants/domain/compare";

/**
 * The variant comparison's reads (RC-870), all over `otel_trace_summaries`
 * through `otel_trace_summaries_project_variant_started_idx`: one project, one
 * experiment, a time window, and row caps on every read. An unbounded aggregate
 * per window gave prod its 500s, so every query here has both bounds.
 *
 * Counts (runs, errors, tokens) cover every trace of the window. Latency, cost,
 * health and scorer figures read the newest `SAMPLE_PER_VARIANT` traces of each
 * variant.
 *
 * Scorer results are not stored per trace (`task_scores_daily` holds daily
 * counts per task). The pass rate is computed here from what the task scorers
 * read: each sampled trace's run (`trace_turns`, key `otlp:<trace id>`) scored
 * by its task's enabled scorers, as the daily job scores it. The judge scorer
 * is left out, as in the job's daily counts.
 */

export const MAX_EXPERIMENT_ROWS = 200;
export const MAX_VARIANTS = 20;
export const SAMPLE_PER_VARIANT = 1_000;
export const SCORED_PER_VARIANT = 300;
const ID_CHUNK = 500;

export type VariantsDb = Pick<
  ReturnType<typeof getDb>,
  "select" | "selectDistinct" | "selectDistinctOn" | "insert" | "update" | "delete" | "execute"
>;

export interface VariantWindow {
  since: Date;
  until: Date;
}

export interface ExperimentVariantRow {
  experiment: string;
  variant: string;
  runs: number;
  lastSeenAt: Date;
}

export interface ExperimentSamples {
  samples: VariantSample[];
  /** True when the experiment had more than `MAX_VARIANTS` variants in the window. */
  truncated: boolean;
}

/** The experiments' variants with their run counts, newest first. */
export async function readExperimentVariants(
  projectId: string,
  window: VariantWindow,
  db: VariantsDb = getDb(),
): Promise<{ rows: ExperimentVariantRow[]; truncated: boolean }> {
  const s = otelTraceSummaries;
  const lastSeen = sql<string>`max(${s.startedAt})`;
  const rows = await db
    .select({
      experiment: s.variantExperiment,
      variant: s.variantName,
      runs: sql<number>`count(*)::int`,
      lastSeenAt: lastSeen,
    })
    .from(s)
    .where(taggedInWindow(projectId, window))
    .groupBy(s.variantExperiment, s.variantName)
    .orderBy(desc(lastSeen), asc(s.variantExperiment), asc(s.variantName))
    .limit(MAX_EXPERIMENT_ROWS + 1);
  return {
    rows: rows.slice(0, MAX_EXPERIMENT_ROWS).map((row) => ({
      experiment: row.experiment!,
      variant: row.variant!,
      runs: Number(row.runs),
      lastSeenAt: new Date(row.lastSeenAt),
    })),
    truncated: rows.length > MAX_EXPERIMENT_ROWS,
  };
}

/** Each variant of one experiment: counts over the window, and the newest traces' facts. */
export async function readExperimentSamples(
  projectId: string,
  experiment: string,
  window: VariantWindow,
  options: { scorers: boolean },
  db: VariantsDb = getDb(),
): Promise<ExperimentSamples> {
  const s = otelTraceSummaries;
  const inExperiment = and(taggedInWindow(projectId, window), eq(s.variantExperiment, experiment));
  const totals = await db
    .select({
      variant: s.variantName,
      runs: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where ${s.hasError})::int`,
      inputTokens: sql<string>`coalesce(sum(${s.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${s.outputTokens}), 0)`,
    })
    .from(s)
    .where(inExperiment)
    .groupBy(s.variantName)
    .orderBy(desc(sql`count(*)`), asc(s.variantName))
    .limit(MAX_VARIANTS + 1);
  const kept = totals.slice(0, MAX_VARIANTS);
  const samples: VariantSample[] = [];
  for (const total of kept) {
    const variant = total.variant!;
    const rows = await db
      .select({
        traceId: s.traceId,
        durationMs: s.durationMs,
        costUsd: s.costUsd,
        hasError: s.hasError,
        attrs: s.variantAttrs,
      })
      .from(s)
      .where(and(inExperiment, eq(s.variantName, variant)))
      .orderBy(desc(s.startedAt), desc(s.traceId))
      .limit(SAMPLE_PER_VARIANT);
    const traces: SampledTrace[] = rows.map((row) => ({
      durationMs: row.durationMs,
      costUsd: Number(row.costUsd),
      hasError: row.hasError,
    }));
    const turns = await readTurns(
      projectId,
      rows.map((row) => row.traceId),
      db,
    );
    samples.push({
      name: variant,
      attrs: rows[0]?.attrs ?? {},
      runs: Number(total.runs),
      errors: Number(total.errors),
      inputTokens: Number(total.inputTokens),
      outputTokens: Number(total.outputTokens),
      traces,
      health: healthOf(turns),
      scorer: options.scorers ? await scorerPassOf(projectId, turns, db) : null,
    });
  }
  return { samples, truncated: totals.length > MAX_VARIANTS };
}

interface TurnFacts {
  id: string;
  workflowId: string | null;
  status: string;
  errorCount: number;
  reSearchCount: number;
  abandoned: boolean | null;
  detour: boolean;
}

function taggedInWindow(projectId: string, window: VariantWindow) {
  const s = otelTraceSummaries;
  return and(
    eq(s.projectId, projectId),
    isNotNull(s.variantExperiment),
    isNotNull(s.variantName),
    gte(s.startedAt, window.since),
    lt(s.startedAt, window.until),
  );
}

/** The OTLP run of each trace (`turn_key = 'otlp:<trace id>'`), through `trace_turns_project_turn_key_idx`. */
async function readTurns(
  projectId: string,
  traceIds: readonly string[],
  db: VariantsDb,
): Promise<TurnFacts[]> {
  const out: TurnFacts[] = [];
  for (let i = 0; i < traceIds.length; i += ID_CHUNK) {
    const keys = traceIds.slice(i, i + ID_CHUNK).map((id) => `otlp:${id}`);
    out.push(
      ...(await db
        .select({
          id: traceTurns.id,
          workflowId: traceTurns.workflowId,
          status: traceTurns.status,
          errorCount: traceTurns.errorCount,
          reSearchCount: traceTurns.reSearchCount,
          abandoned: traceTurns.abandoned,
          detour: traceTurns.detour,
        })
        .from(traceTurns)
        .where(and(eq(traceTurns.projectId, projectId), inArray(traceTurns.turnKey, keys)))),
    );
  }
  return out;
}

/** The per-run facts the health signals read, as rates over the runs that measured them. */
function healthOf(turns: readonly TurnFacts[]): VariantSample["health"] {
  if (turns.length === 0) return {};
  const health: VariantSample["health"] = {
    tool_errors: { n: turns.length, hits: turns.filter((turn) => turn.errorCount > 0).length },
    self_corrections: {
      n: turns.length,
      hits: turns.filter((turn) => turn.reSearchCount > 0).length,
    },
    detours: { n: turns.length, hits: turns.filter((turn) => turn.detour).length },
  };
  const measured = turns.filter((turn) => turn.abandoned !== null);
  if (measured.length > 0)
    health.abandoned = {
      n: measured.length,
      hits: measured.filter((turn) => turn.abandoned).length,
    };
  return health satisfies Partial<Record<HealthKind, unknown>>;
}

/** Closed runs that belong to a task, scored by that task's enabled scorers: all pass, or not. */
async function scorerPassOf(
  projectId: string,
  turns: readonly TurnFacts[],
  db: VariantsDb,
): Promise<VariantSample["scorer"]> {
  const tasked = turns
    .filter((turn) => turn.status === "closed" && turn.workflowId !== null)
    .slice(0, SCORED_PER_VARIANT);
  if (tasked.length === 0) return null;
  const runs = await loadRuns(
    projectId,
    tasked.map((turn) => turn.id),
    db,
  );
  const scorersByTask = new Map<string, Scorer[]>();
  let n = 0;
  let passed = 0;
  for (const turn of tasked) {
    const run = runs.get(turn.id);
    if (!run) continue;
    const taskId = turn.workflowId!;
    let scorers = scorersByTask.get(taskId);
    if (!scorers) {
      scorers = (await scorersFor(projectId, taskId, db)).filter(
        (scorer) => scorer.enabled && scorer.kind !== "judge_criteria",
      );
      scorersByTask.set(taskId, scorers);
    }
    const verdict = overallPass(run, scorers);
    if (verdict === null) continue;
    n++;
    if (verdict) passed++;
  }
  return n > 0 ? { n, passed } : null;
}

/** As the daily job counts "overall": every measured scorer passes; null when none measured the run. */
function overallPass(run: RunRecord, scorers: readonly Scorer[]): boolean | null {
  const expected = scorers.find((scorer) => scorer.kind === "expected_tool");
  const results = scoreRun(
    recordedView(run, expected?.kind === "expected_tool" ? expected.tool : null),
    scorers,
  ).filter((result) => result.status !== "skip");
  if (results.length === 0) return null;
  return results.every((result) => result.status === "pass");
}

/** Of `projectIds`, those with a tagged trace since `since`: one indexed probe each. */
export async function projectsWithVariantTraffic(
  projectIds: readonly string[],
  since: Date,
  db: VariantsDb = getDb(),
): Promise<string[]> {
  const s = otelTraceSummaries;
  const found: string[] = [];
  for (const projectId of projectIds) {
    const [row] = await db
      .select({ one: sql<number>`1` })
      .from(s)
      .where(
        and(
          eq(s.projectId, projectId),
          isNotNull(s.variantExperiment),
          isNotNull(s.variantName),
          gte(s.startedAt, since),
        ),
      )
      .limit(1);
    if (row) found.push(projectId);
  }
  return found;
}
