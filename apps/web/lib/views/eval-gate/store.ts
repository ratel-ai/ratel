import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { STALE_JOB_MS } from "@/lib/jobs/queries";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { projects } from "@/lib/platform/projects/schema";
import { parseExpected } from "@/lib/views/eval-gate/defaults";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import {
  type FixEvalRunRow,
  type FixEvalSetRow,
  fixEvalCases,
  fixEvalRuns,
  fixEvalSets,
} from "@/lib/views/eval-gate/schema";
import { evalGateSeams } from "@/lib/views/eval-gate/seams";
import {
  CASE_ORIGINS,
  type CaseOrigin,
  type CaseResult,
  type EvalCase,
  type EvalRunStatus,
  type Expected,
  type FixChange,
  type JudgeStatus,
  type MethodTally,
  type ModelSpend,
  RUN_STATUSES,
  type SimulationSummary,
  type Tally,
  VERDICTS,
  type Verdict,
} from "@/lib/views/eval-gate/types";
import type { LineageRef } from "@/lib/views/lineage/types";

/**
 * The eval gate's rows: one set per fix, its runs (cases) and its
 * simulations. Every read and write is scoped to the project.
 */

/** The most runs one set holds. */
export const MAX_CASES = 100;

export interface NewCase {
  turnId: string;
  traceId: string | null;
  origin: CaseOrigin;
  originRef: string | null;
  expected: Expected;
  outcome?: string;
  criteria?: string;
}

export async function getEvalSet(
  projectId: string,
  fixId: string,
  db: EvalDb = getDb(),
): Promise<FixEvalSetRow | null> {
  const [row] = await db
    .select()
    .from(fixEvalSets)
    .where(and(eq(fixEvalSets.projectId, projectId), eq(fixEvalSets.fixId, fixId)))
    .limit(1);
  return row ?? null;
}

export async function getEvalSetById(
  setId: string,
  db: EvalDb = getDb(),
): Promise<FixEvalSetRow | null> {
  const [row] = await db.select().from(fixEvalSets).where(eq(fixEvalSets.id, setId)).limit(1);
  return row ?? null;
}

/** The set for a fix, made once: a race reads back the row that won. */
export async function createEvalSet(
  input: {
    projectId: string;
    fixId: string;
    fixKind: string;
    title: string;
    change: FixChange;
    source: LineageRef | null;
    createdBy: string;
    targetRuns?: number;
    evidenceTurnIds?: readonly string[];
  },
  db: EvalDb = getDb(),
): Promise<{ set: FixEvalSetRow; created: boolean }> {
  const [row] = await db
    .insert(fixEvalSets)
    .values({
      projectId: input.projectId,
      fixId: input.fixId,
      fixKind: input.fixKind,
      title: input.title,
      change: input.change as unknown as Record<string, unknown>,
      source: input.source as unknown as Record<string, unknown> | null,
      createdBy: input.createdBy,
      ...(input.targetRuns ? { targetRuns: input.targetRuns } : {}),
      ...(input.evidenceTurnIds ? { evidenceTurnIds: [...input.evidenceTurnIds] } : {}),
    })
    .onConflictDoNothing({ target: [fixEvalSets.projectId, fixEvalSets.fixId] })
    .returning();
  if (row) return { set: row, created: true };
  const existing = await getEvalSet(input.projectId, input.fixId, db);
  if (!existing) throw new Error("eval set vanished after a conflicting insert");
  return { set: existing, created: false };
}

/**
 * Refresh a set's change from the fix (the fix may have been redrafted), and the
 * runs its issues cite (RC-61). Writes only on a real difference. `updated_at` is
 * what marks the last simulation stale, so it moves only when the change or the
 * title differs: re-reading an unchanged fix must not move it, and new evidence
 * alone (an issue picking up another run) refreshes the holdout split without
 * invalidating the result. Returns the updated row, or null when nothing changed.
 * The change is compared as jsonb, so key order doesn't count as a difference;
 * evidence is stored sorted, so its order doesn't either.
 */
export async function updateEvalSetChange(
  setId: string,
  change: FixChange,
  title: string,
  db: EvalDb = getDb(),
  evidenceTurnIds?: readonly string[],
): Promise<FixEvalSetRow | null> {
  const changed = sql`(${fixEvalSets.change} is distinct from ${JSON.stringify(change)}::jsonb or ${fixEvalSets.title} is distinct from ${title})`;
  const evidence = evidenceTurnIds ? [...new Set(evidenceTurnIds)].sort() : undefined;
  const evidenceChanged = evidence
    ? sql`${fixEvalSets.evidenceTurnIds} is distinct from ${sqlTextArray(evidence)}`
    : sql`false`;
  const [row] = await db
    .update(fixEvalSets)
    .set({
      change: change as unknown as Record<string, unknown>,
      title,
      updatedAt: sql`case when ${changed} then now() else ${fixEvalSets.updatedAt} end`,
      ...(evidence ? { evidenceTurnIds: evidence } : {}),
    })
    .where(and(eq(fixEvalSets.id, setId), sql`(${changed} or ${evidenceChanged})`))
    .returning();
  return row ?? null;
}

/** A text[] literal for comparisons (drizzle binds a JS array as a record otherwise). */
function sqlTextArray(values: readonly string[]) {
  return values.length === 0
    ? sql`'{}'::text[]`
    : sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;
}

async function touchSet(setId: string, db: EvalDb): Promise<void> {
  await db.update(fixEvalSets).set({ updatedAt: new Date() }).where(eq(fixEvalSets.id, setId));
}

function toCase(row: typeof fixEvalCases.$inferSelect): EvalCase {
  return {
    id: row.id,
    turnId: row.turnId,
    traceId: row.traceId,
    origin: (CASE_ORIGINS as readonly string[]).includes(row.origin)
      ? (row.origin as CaseOrigin)
      : "manual",
    originRef: row.originRef,
    expected: parseExpected(row.expected),
    outcome: row.outcome,
    criteria: row.criteria,
    position: row.position,
  };
}

export async function listCases(setId: string, db: EvalDb = getDb()): Promise<EvalCase[]> {
  const rows = await db
    .select()
    .from(fixEvalCases)
    .where(eq(fixEvalCases.setId, setId))
    .orderBy(asc(fixEvalCases.position), asc(fixEvalCases.createdAt));
  return rows.map(toCase);
}

/** Add runs at the end of the set; a run already in it is left as is. Returns how many were added. */
export async function addCases(
  set: Pick<FixEvalSetRow, "id" | "projectId">,
  cases: readonly NewCase[],
  db: EvalDb = getDb(),
): Promise<number> {
  if (cases.length === 0) return 0;
  const [{ count, top }] = (await db
    .select({
      count: sql<number>`count(*)::int`,
      top: sql<number>`coalesce(max(${fixEvalCases.position}), -1)::int`,
    })
    .from(fixEvalCases)
    .where(eq(fixEvalCases.setId, set.id))) as [{ count: number; top: number }];
  const room = Math.max(0, MAX_CASES - count);
  const rows = cases.slice(0, room).map((item, index) => ({
    setId: set.id,
    projectId: set.projectId,
    turnId: item.turnId,
    traceId: item.traceId,
    origin: item.origin,
    originRef: item.originRef,
    expected: item.expected as unknown as Record<string, unknown>,
    outcome: item.outcome ?? "",
    criteria: item.criteria ?? "",
    position: top + 1 + index,
  }));
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(fixEvalCases)
    .values(rows)
    .onConflictDoNothing({ target: [fixEvalCases.setId, fixEvalCases.turnId] })
    .returning({ id: fixEvalCases.id });
  if (inserted.length > 0) await touchSet(set.id, db);
  return inserted.length;
}

export async function updateCase(
  setId: string,
  caseId: string,
  patch: { expected: Expected; outcome: string; criteria: string },
  db: EvalDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(fixEvalCases)
    .set({
      expected: patch.expected as unknown as Record<string, unknown>,
      outcome: patch.outcome,
      criteria: patch.criteria,
      updatedAt: new Date(),
    })
    .where(and(eq(fixEvalCases.setId, setId), eq(fixEvalCases.id, caseId)))
    .returning({ id: fixEvalCases.id });
  if (rows.length > 0) await touchSet(setId, db);
  return rows.length > 0;
}

export async function removeCase(
  setId: string,
  caseId: string,
  db: EvalDb = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(fixEvalCases)
    .where(and(eq(fixEvalCases.setId, setId), eq(fixEvalCases.id, caseId)))
    .returning({ id: fixEvalCases.id });
  if (rows.length > 0) await touchSet(setId, db);
  return rows.length > 0;
}

/* - Simulations -------------------------------------------------------------- */

const LIVE_STATUSES = ["queued", "running"] as const;

/**
 * A live (queued or running) simulation older than this never finishes: its
 * job failed to enqueue, or its worker died and the jobs reaper (`STALE_JOB_MS`)
 * already gave up on it. Past the reaper's window, like trace-signals'
 * `STALE_RUN_MS`, so a run is never failed while its job may still be alive.
 */
export const STALE_EVAL_RUN_MS = STALE_JOB_MS + 5 * 60_000;

/** The error a timed-out simulation is failed with. */
export const STALE_EVAL_RUN_ERROR = "Timed out: no result was recorded.";

/** Whether a live run has outlived `STALE_EVAL_RUN_MS` (counted from its start, else its queueing). */
export function isTimedOut(
  run: Pick<FixEvalRunRow, "status" | "startedAt" | "createdAt">,
  now: number = Date.now(),
): boolean {
  if (!(LIVE_STATUSES as readonly string[]).includes(run.status)) return false;
  return (run.startedAt ?? run.createdAt).getTime() < now - STALE_EVAL_RUN_MS;
}

const logger = getLogger("eval-gate/store");

/**
 * Fail the set's live run when it has timed out, freeing the set for a new one.
 * Returns how many were failed. Each logs `fix_eval_run_timed_out`: a run only
 * gets here when its job never recorded a result, so the improvement loop
 * dashboard and its stuck-runs monitor count them.
 */
export async function reapStaleEvalRuns(
  setId: string,
  db: EvalDb = getDb(),
  now: Date = new Date(),
): Promise<number> {
  const before = new Date(now.getTime() - STALE_EVAL_RUN_MS);
  const rows = await db
    .update(fixEvalRuns)
    .set({ status: "failed", error: STALE_EVAL_RUN_ERROR, finishedAt: now })
    .where(
      and(
        eq(fixEvalRuns.setId, setId),
        inArray(fixEvalRuns.status, [...LIVE_STATUSES]),
        lt(sql`coalesce(${fixEvalRuns.startedAt}, ${fixEvalRuns.createdAt})`, before),
      ),
    )
    .returning({ id: fixEvalRuns.id, projectId: fixEvalRuns.projectId });
  for (const row of rows) {
    logger.warn(
      { run_id: row.id, set_id: setId, project_id: row.projectId, timeout_ms: STALE_EVAL_RUN_MS },
      "fix_eval_run_timed_out",
    );
  }
  return rows.length;
}

/** A queued simulation, or the one already queued or running for this set (a timed-out one is failed first). */
export async function queueEvalRun(
  set: Pick<FixEvalSetRow, "id" | "projectId">,
  input: { trigger: "manual" | "mcp"; requestedBy: string; replay?: boolean },
  db: EvalDb = getDb(),
): Promise<{ run: FixEvalRunRow; created: boolean }> {
  await reapStaleEvalRuns(set.id, db);
  const [row] = await db
    .insert(fixEvalRuns)
    .values({
      setId: set.id,
      projectId: set.projectId,
      trigger: input.trigger,
      requestedBy: input.requestedBy,
      status: "queued",
      replay: input.replay ?? false,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { run: row, created: true };
  const live = await liveRun(set.id, db);
  if (!live) throw new Error("live eval run vanished after a conflicting insert");
  return { run: live, created: false };
}

export async function liveRun(setId: string, db: EvalDb = getDb()): Promise<FixEvalRunRow | null> {
  const [row] = await db
    .select()
    .from(fixEvalRuns)
    .where(and(eq(fixEvalRuns.setId, setId), inArray(fixEvalRuns.status, [...LIVE_STATUSES])))
    .limit(1);
  return row ?? null;
}

export async function setRunJob(runId: string, jobId: string, db: EvalDb = getDb()): Promise<void> {
  await db.update(fixEvalRuns).set({ jobId }).where(eq(fixEvalRuns.id, runId));
}

/** Claim a queued run; null when another worker has it or it is gone. */
export async function startEvalRun(
  runId: string,
  db: EvalDb = getDb(),
): Promise<FixEvalRunRow | null> {
  const [row] = await db
    .update(fixEvalRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(fixEvalRuns.id, runId), eq(fixEvalRuns.status, "queued")))
    .returning();
  return row ?? null;
}

export async function completeEvalRun(
  runId: string,
  input: {
    summary: SimulationSummary;
    results: readonly CaseResult[];
    change: FixChange;
    spend?: ModelSpend | null;
    judge?: JudgeStatus | null;
  },
  db: EvalDb = getDb(),
): Promise<FixEvalRunRow | null> {
  const { summary } = input;
  const [row] = await db
    .update(fixEvalRuns)
    .set({
      status: "completed",
      nCases: summary.nCases,
      nSimulated: summary.nSimulated,
      before: summary.before as unknown as Record<string, unknown>,
      after: summary.after as unknown as Record<string, unknown>,
      interval: summary.interval as unknown as Record<string, unknown> | null,
      verdict: summary.verdict,
      results: input.results as unknown as Record<string, unknown>[],
      change: input.change as unknown as Record<string, unknown>,
      evidence: (summary.evidence ?? null) as unknown as Record<string, unknown> | null,
      breakdown: (summary.breakdown ?? null) as unknown as Record<string, unknown> | null,
      methods: (summary.methods ?? null) as unknown as Record<string, unknown> | null,
      spend: (input.spend ?? null) as unknown as Record<string, unknown> | null,
      judge: (input.judge ?? null) as unknown as Record<string, unknown> | null,
      finishedAt: new Date(),
    })
    .where(eq(fixEvalRuns.id, runId))
    .returning();
  return row ?? null;
}

export async function failEvalRun(
  runId: string,
  error: string,
  db: EvalDb = getDb(),
): Promise<void> {
  await db
    .update(fixEvalRuns)
    .set({ status: "failed", error: error.slice(0, 500), finishedAt: new Date() })
    .where(eq(fixEvalRuns.id, runId));
}

/**
 * What the simulations of this project's organization spent on models since
 * `since` (replay and judge, as stored on each finished run): every project of
 * the organization counts toward its one daily budget.
 */
export async function organizationModelSpendSince(
  projectId: string,
  since: Date,
  db: EvalDb = getDb(),
): Promise<number> {
  const [row] = await db
    .select({
      usd: sql<string | number | null>`coalesce(sum((${fixEvalRuns.spend}->>'usd')::numeric), 0)`,
    })
    .from(fixEvalRuns)
    .innerJoin(projects, eq(projects.id, fixEvalRuns.projectId))
    .where(
      and(
        sql`${projects.organizationId} = (select ${projects.organizationId} from ${projects} where ${projects.id} = ${projectId})`,
        sql`coalesce(${fixEvalRuns.finishedAt}, ${fixEvalRuns.createdAt}) >= ${since.toISOString()}::timestamptz`,
      ),
    );
  // Owned (ADR-0030): fix drafts, the task loop and What-if add what they spent through the seam.
  const others = await Promise.all(
    evalGateSeams.spendSince.map((read) => read(projectId, since, db)),
  );
  const usd = others.reduce((sum, value) => sum + Number(value ?? 0), Number(row?.usd ?? 0));
  return Number.isFinite(usd) ? usd : 0;
}

export async function getEvalRun(
  runId: string,
  db: EvalDb = getDb(),
): Promise<FixEvalRunRow | null> {
  const [row] = await db.select().from(fixEvalRuns).where(eq(fixEvalRuns.id, runId)).limit(1);
  return row ?? null;
}

export async function listEvalRuns(
  setId: string,
  limit = 10,
  db: EvalDb = getDb(),
): Promise<FixEvalRunRow[]> {
  return db
    .select()
    .from(fixEvalRuns)
    .where(eq(fixEvalRuns.setId, setId))
    .orderBy(desc(fixEvalRuns.createdAt))
    .limit(limit);
}

export interface SetWithLatestRun {
  set: FixEvalSetRow;
  run: FixEvalRunRow | null;
}

/** Every set of the project with its newest simulation, for the badges on Fixes. */
export async function listSetsWithLatestRun(
  projectId: string,
  db: EvalDb = getDb(),
): Promise<SetWithLatestRun[]> {
  const sets = await db.select().from(fixEvalSets).where(eq(fixEvalSets.projectId, projectId));
  if (sets.length === 0) return [];
  const runs = await db
    .selectDistinctOn([fixEvalRuns.setId])
    .from(fixEvalRuns)
    .where(eq(fixEvalRuns.projectId, projectId))
    .orderBy(fixEvalRuns.setId, desc(fixEvalRuns.createdAt));
  const bySet = new Map(runs.map((run) => [run.setId, run]));
  return sets.map((set) => ({ set, run: bySet.get(set.id) ?? null }));
}

/* - Reading stored values back ---------------------------------------------- */

export function parseStatus(value: string): EvalRunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value) ? (value as EvalRunStatus) : "failed";
}

export function parseVerdict(value: string | null): Verdict | null {
  return value && (VERDICTS as readonly string[]).includes(value) ? (value as Verdict) : null;
}

export function parseTally(value: unknown): Tally | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const n = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? raw : null);
  return {
    passed: n(record.passed) ?? 0,
    total: n(record.total) ?? 0,
    passRate: n(record.passRate),
    score: n(record.score),
  };
}

export function parseResults(value: unknown): CaseResult[] {
  return Array.isArray(value)
    ? (value.filter(
        (item) =>
          item && typeof item === "object" && typeof (item as CaseResult).caseId === "string",
      ) as CaseResult[])
    : [];
}

/* - RC-61 reads ------------------------------------------------------------- */

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseMethods(value: unknown): MethodTally | null {
  const raw = record(value);
  if (!raw) return null;
  const n = (item: unknown) => (typeof item === "number" && Number.isFinite(item) ? item : 0);
  const fidelity = record(raw.fidelity);
  return {
    rerank: n(raw.rerank),
    replay: n(raw.replay),
    none: n(raw.none),
    reasons: Array.isArray(raw.reasons)
      ? raw.reasons.flatMap((item) => {
          const reason = record(item);
          return reason && typeof reason.note === "string"
            ? [{ note: reason.note, runs: n(reason.runs) }]
            : [];
        })
      : [],
    fidelity: fidelity ? { matched: n(fidelity.matched), total: n(fidelity.total) } : null,
  };
}

export function parseSpend(value: unknown): ModelSpend | null {
  const raw = record(value);
  if (!raw || typeof raw.usd !== "number") return null;
  const n = (item: unknown) => (typeof item === "number" && Number.isFinite(item) ? item : 0);
  return {
    usd: raw.usd,
    calls: n(raw.calls),
    inputTokens: n(raw.inputTokens),
    outputTokens: n(raw.outputTokens),
    capUsd: n(raw.capUsd),
    capped: raw.capped === true,
    models: Array.isArray(raw.models)
      ? raw.models.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export function parseJudge(value: unknown): JudgeStatus | null {
  const raw = record(value);
  if (!raw || typeof raw.status !== "string") return null;
  return raw as unknown as JudgeStatus;
}

export function parseEvidence(value: unknown): SimulationSummary["evidence"] {
  const raw = record(value);
  if (!raw) return null;
  const before = parseTally(raw.before);
  const after = parseTally(raw.after);
  return before && after
    ? { before, after, nSimulated: typeof raw.nSimulated === "number" ? raw.nSimulated : 0 }
    : null;
}

export function parseBreakdown(value: unknown): SimulationSummary["breakdown"] {
  const raw = record(value);
  if (!raw) return null;
  const pair = (item: unknown) => {
    const group = record(item);
    const before = group ? parseTally(group.before) : null;
    const after = group ? parseTally(group.after) : null;
    return before && after ? { before, after } : null;
  };
  const target = pair(raw.target);
  const outcome = pair(raw.outcome);
  const criteria = pair(raw.criteria);
  return target && outcome && criteria ? { target, outcome, criteria } : null;
}
