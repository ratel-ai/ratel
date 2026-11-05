import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { traceSignals } from "@/lib/readings/trace-signals/schema";
import { callTotals, loadModelCalls } from "./calls";
import type { CaseOrigin, RunRecord, RunStep } from "./types";

/**
 * The runs an eval set is made of, read from the project's own traces: the
 * Agent health turn ledger (`trace_turns`, `trace_turn_steps`) and, for a
 * search's text, the live `trace_events` row (pruned after 30 days; never
 * copied anywhere). Every read is scoped to the project.
 */

export type EvalDb = Pick<
  ReturnType<typeof getDb>,
  "select" | "selectDistinct" | "selectDistinctOn" | "insert" | "update" | "delete" | "execute"
>;

const ID_CHUNK = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunCandidate {
  turnId: string;
  origin: Exclude<CaseOrigin, "manual">;
  originRef: string | null;
}

export interface SelectionInput {
  projectId: string;
  /** The issues (insights) the fix resolves: their evidence runs come first. */
  issueIds: readonly string[];
  tools: readonly string[];
  tasks: readonly string[];
  limit: number;
  /** Runs already in the set, never picked twice. */
  exclude?: ReadonlySet<string>;
}

/**
 * Up to `limit` runs for a fix, in order: the evidence of the issues it
 * resolves (newest first, as Agent health samples them), then the newest runs
 * that ran or were offered one of its tools, then its task's newest runs.
 */
export async function selectRuns(
  input: SelectionInput,
  db: EvalDb = getDb(),
): Promise<RunCandidate[]> {
  const picked = new Map<string, RunCandidate>();
  const exclude = input.exclude ?? new Set<string>();
  const take = (candidates: readonly RunCandidate[]) => {
    for (const candidate of candidates) {
      if (picked.size >= input.limit) return;
      if (
        !UUID.test(candidate.turnId) ||
        exclude.has(candidate.turnId) ||
        picked.has(candidate.turnId)
      )
        continue;
      picked.set(candidate.turnId, candidate);
    }
  };

  const issueIds = input.issueIds.filter((id) => UUID.test(id));
  if (issueIds.length > 0) {
    const rows = await db
      .select({ id: traceSignals.id, evidence: traceSignals.evidence })
      .from(traceSignals)
      .where(and(eq(traceSignals.projectId, input.projectId), inArray(traceSignals.id, issueIds)));
    const byId = new Map(rows.map((row) => [row.id, row.evidence]));
    // The issues in the fix's order (worst first), each one's runs in turn.
    const fromIssues = issueIds.flatMap((id) =>
      turnIdsOf(byId.get(id)).map((turnId) => ({
        turnId,
        origin: "issue" as const,
        originRef: id,
      })),
    );
    take(await closedOnly(input.projectId, fromIssues, db));
  }

  if (picked.size < input.limit && input.tools.length > 0) {
    const tools = [...input.tools];
    const rows = await db
      .selectDistinct({ id: traceTurns.id, endedAt: traceTurns.endedAt })
      .from(traceTurnSteps)
      .innerJoin(traceTurns, eq(traceTurns.id, traceTurnSteps.turnId))
      .where(
        and(
          eq(traceTurnSteps.projectId, input.projectId),
          eq(traceTurns.status, "closed"),
          or(
            inArray(traceTurnSteps.targetId, tools),
            sql`${traceTurnSteps.hitIds} && array[${sql.join(
              tools.map((tool) => sql`${tool}`),
              sql`, `,
            )}]::text[]`,
          ),
        ),
      )
      .orderBy(desc(traceTurns.endedAt), desc(traceTurns.id))
      .limit(input.limit * 3 + exclude.size);
    take(rows.map((row) => ({ turnId: row.id, origin: "tool" as const, originRef: null })));
  }

  if (picked.size < input.limit && input.tasks.length > 0) {
    const rows = await db
      .select({ id: traceTurns.id, workflowId: traceTurns.workflowId })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, input.projectId),
          eq(traceTurns.status, "closed"),
          inArray(traceTurns.workflowId, [...input.tasks]),
        ),
      )
      .orderBy(desc(traceTurns.endedAt), desc(traceTurns.id))
      .limit(input.limit * 2 + exclude.size);
    take(
      rows.map((row) => ({ turnId: row.id, origin: "task" as const, originRef: row.workflowId })),
    );
  }

  return [...picked.values()];
}

/** Every run the issues cite as evidence (`trace_signals.evidence.turnIds`), worst issue first. */
export async function loadEvidenceTurnIds(
  projectId: string,
  issueIds: readonly string[],
  db: EvalDb = getDb(),
): Promise<string[]> {
  const ids = issueIds.filter((id) => UUID.test(id));
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: traceSignals.id, evidence: traceSignals.evidence })
    .from(traceSignals)
    .where(and(eq(traceSignals.projectId, projectId), inArray(traceSignals.id, ids)));
  const byId = new Map(rows.map((row) => [row.id, row.evidence]));
  return [...new Set(ids.flatMap((id) => turnIdsOf(byId.get(id))))];
}

export interface HoldoutSelection {
  /** Runs that match the fix but aren't the insight's evidence: the runs that grade it. */
  holdout: RunCandidate[];
  /** The insight's own runs, kept apart for comparison. */
  evidence: RunCandidate[];
}

/**
 * RC-61: runs for a fix with the insight's evidence held out. Holdout runs
 * are the newest runs of the fix's tools, then of its task, never one the
 * issue cites (a pool of `pool` candidates, so the caller can put the runs
 * the change touches first); evidence runs are listed apart, up to
 * `evidenceLimit`.
 */
export async function selectHoldoutRuns(
  input: Omit<SelectionInput, "limit"> & { pool: number; evidenceLimit: number },
  db: EvalDb = getDb(),
): Promise<HoldoutSelection> {
  const evidenceIds = new Set(await loadEvidenceTurnIds(input.projectId, input.issueIds, db));
  const exclude = new Set([...(input.exclude ?? []), ...evidenceIds]);
  let holdout = await selectRuns(
    {
      projectId: input.projectId,
      issueIds: [],
      tools: input.tools,
      tasks: input.tasks,
      limit: input.pool,
      exclude,
    },
    db,
  );
  if (holdout.length === 0 && input.tools.length === 0 && input.tasks.length === 0) {
    // A fix that names no tool or task (fewer results per search) touches every run that searched.
    const rows = await db
      .select({ id: traceTurns.id })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, input.projectId),
          eq(traceTurns.status, "closed"),
          sql`${traceTurns.searchCount} > 0`,
        ),
      )
      .orderBy(desc(traceTurns.endedAt), desc(traceTurns.id))
      .limit(input.pool + exclude.size);
    holdout = rows
      .filter((row) => !exclude.has(row.id))
      .slice(0, input.pool)
      .map((row) => ({ turnId: row.id, origin: "tool" as const, originRef: null }));
  }
  const evidence: RunCandidate[] = [];
  if (input.evidenceLimit > 0 && evidenceIds.size > 0) {
    const already = input.exclude ?? new Set<string>();
    const issueIds = input.issueIds.filter((id) => UUID.test(id));
    const rows = await db
      .select({ id: traceSignals.id, evidence: traceSignals.evidence })
      .from(traceSignals)
      .where(and(eq(traceSignals.projectId, input.projectId), inArray(traceSignals.id, issueIds)));
    const byId = new Map(rows.map((row) => [row.id, row.evidence]));
    const fromIssues = issueIds.flatMap((id) =>
      turnIdsOf(byId.get(id)).map((turnId) => ({
        turnId,
        origin: "issue" as const,
        originRef: id,
      })),
    );
    for (const candidate of await closedOnly(input.projectId, fromIssues, db)) {
      if (evidence.length >= input.evidenceLimit) break;
      if (
        already.has(candidate.turnId) ||
        evidence.some((item) => item.turnId === candidate.turnId)
      )
        continue;
      evidence.push(candidate);
    }
  }
  return { holdout, evidence };
}

function turnIdsOf(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== "object") return [];
  const ids = (evidence as Record<string, unknown>).turnIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/** The candidates whose run is still in the ledger and closed, order kept. */
async function closedOnly(
  projectId: string,
  candidates: readonly RunCandidate[],
  db: EvalDb,
): Promise<RunCandidate[]> {
  const ids = [
    ...new Set(candidates.map((candidate) => candidate.turnId).filter((id) => UUID.test(id))),
  ];
  const live = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const rows = await db
      .select({ id: traceTurns.id })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, projectId),
          eq(traceTurns.status, "closed"),
          inArray(traceTurns.id, ids.slice(i, i + ID_CHUNK)),
        ),
      );
    for (const row of rows) live.add(row.id);
  }
  return candidates.filter((candidate) => live.has(candidate.turnId));
}

/**
 * A run a person names by its run id (`trace_turns.id`) or its trace id:
 * the turn, when it is this project's. A trace with several runs names its first.
 */
export async function findRun(
  projectId: string,
  raw: string,
  db: EvalDb = getDb(),
): Promise<{ turnId: string; traceId: string | null } | null> {
  const value = raw.trim();
  if (!value) return null;
  if (UUID.test(value)) {
    const [turn] = await db
      .select({ id: traceTurns.id })
      .from(traceTurns)
      .where(and(eq(traceTurns.projectId, projectId), eq(traceTurns.id, value)))
      .limit(1);
    if (turn)
      return {
        turnId: turn.id,
        traceId: (await traceIdsOf(projectId, [turn.id], db)).get(turn.id) ?? null,
      };
  }
  const [step] = await db
    .select({ turnId: traceTurnSteps.turnId })
    .from(traceTurnSteps)
    .innerJoin(traceEvents, eq(traceEvents.id, traceTurnSteps.traceEventId))
    .where(and(eq(traceTurnSteps.projectId, projectId), eq(traceEvents.traceId, value)))
    .orderBy(traceTurnSteps.occurredAt)
    .limit(1);
  return step ? { turnId: step.turnId, traceId: value } : null;
}

/** Each run's trace id, from its first step's event (absent once pruned). */
export async function traceIdsOf(
  projectId: string,
  turnIds: readonly string[],
  db: EvalDb = getDb(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < turnIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        turnId: traceTurnSteps.turnId,
        traceId: traceEvents.traceId,
        ordinal: traceTurnSteps.ordinal,
      })
      .from(traceTurnSteps)
      .innerJoin(traceEvents, eq(traceEvents.id, traceTurnSteps.traceEventId))
      .where(
        and(
          eq(traceTurnSteps.projectId, projectId),
          inArray(traceTurnSteps.turnId, turnIds.slice(i, i + ID_CHUNK)),
        ),
      )
      .orderBy(traceTurnSteps.turnId, traceTurnSteps.ordinal);
    for (const row of rows)
      if (row.traceId && !out.has(row.turnId)) out.set(row.turnId, row.traceId);
  }
  return out;
}

/** The runs as the simulator reads them; a run no longer in the ledger is simply absent. */
export async function loadRuns(
  projectId: string,
  turnIds: readonly string[],
  db: EvalDb = getDb(),
): Promise<Map<string, RunRecord>> {
  const out = new Map<string, RunRecord>();
  const ids = [...new Set(turnIds.filter((id) => UUID.test(id)))];
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const heads = await db
      .select({
        id: traceTurns.id,
        startedAt: traceTurns.startedAt,
        endedAt: traceTurns.endedAt,
        workflowId: traceTurns.workflowId,
        turnKey: traceTurns.turnKey,
      })
      .from(traceTurns)
      .where(and(eq(traceTurns.projectId, projectId), inArray(traceTurns.id, chunk)));
    if (heads.length === 0) continue;
    const steps = await db
      .select({
        turnId: traceTurnSteps.turnId,
        ordinal: traceTurnSteps.ordinal,
        kind: traceTurnSteps.kind,
        traceEventId: traceTurnSteps.traceEventId,
        searchType: traceTurnSteps.searchType,
        hitIds: traceTurnSteps.hitIds,
        topK: traceTurnSteps.topK,
        targetId: traceTurnSteps.targetId,
        outcome: traceTurnSteps.outcome,
      })
      .from(traceTurnSteps)
      .where(
        and(
          eq(traceTurnSteps.projectId, projectId),
          inArray(
            traceTurnSteps.turnId,
            heads.map((head) => head.id),
          ),
        ),
      )
      .orderBy(traceTurnSteps.turnId, traceTurnSteps.ordinal);
    const eventIds = [...new Set(steps.map((step) => step.traceEventId))];
    const events = new Map<string, { query: string | null; traceId: string | null }>();
    for (let j = 0; j < eventIds.length; j += ID_CHUNK) {
      const rows = await db
        .select({ id: traceEvents.id, query: traceEvents.query, traceId: traceEvents.traceId })
        .from(traceEvents)
        .where(
          and(
            eq(traceEvents.projectId, projectId),
            inArray(traceEvents.id, eventIds.slice(j, j + ID_CHUNK)),
          ),
        );
      for (const row of rows) events.set(row.id, { query: row.query, traceId: row.traceId });
    }
    const traces = new Map(
      heads.map((head) => {
        const mine = steps.filter((step) => step.turnId === head.id);
        const ids = new Set(
          mine
            .map((step) => events.get(step.traceEventId)?.traceId ?? null)
            .filter((id): id is string => !!id),
        );
        if (head.turnKey.startsWith("otlp:")) ids.add(head.turnKey.slice("otlp:".length));
        return [head.id, [...ids]] as const;
      }),
    );
    // RC-61: what the run's model calls cost and whether it ended in an answer.
    const calls = await loadModelCalls(
      projectId,
      heads.map((head) => ({
        turnId: head.id,
        startedAt: head.startedAt,
        endedAt: head.endedAt,
        traceIds: traces.get(head.id) ?? [],
      })),
      {},
      db,
    );
    for (const head of heads) {
      const mine = steps.filter((step) => step.turnId === head.id);
      const traceId =
        mine
          .map((step) => events.get(step.traceEventId)?.traceId ?? null)
          .find((id) => id !== null) ?? null;
      const totals = callTotals(calls.get(head.id) ?? []);
      out.set(head.id, {
        turnId: head.id,
        traceId,
        startedAt: head.startedAt.toISOString(),
        endedAt: head.endedAt.toISOString(),
        traceIds: [...(traces.get(head.id) ?? [])],
        durationMs: Math.max(0, head.endedAt.getTime() - head.startedAt.getTime()),
        costUsd: totals.costUsd,
        answered: totals.answered,
        taskId: head.workflowId,
        steps: mine.flatMap((step): RunStep[] => {
          if (step.kind === "search") {
            const query = events.get(step.traceEventId)?.query ?? null;
            return [
              {
                kind: "search",
                ordinal: step.ordinal,
                searchType: step.searchType,
                query: query && query.trim() ? query : null,
                hitIds: step.hitIds,
                topK: step.topK,
              },
            ];
          }
          if (step.kind === "invoke" && step.targetId) {
            const outcome =
              step.outcome === "ok" || step.outcome === "error" ? step.outcome : "unknown";
            return [{ kind: "invoke", ordinal: step.ordinal, targetId: step.targetId, outcome }];
          }
          return [];
        }),
      });
    }
  }
  return out;
}
