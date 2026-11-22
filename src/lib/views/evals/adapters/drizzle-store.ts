import { and, asc, desc, eq, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import {
  type EvalResultRow,
  type EvalRow,
  type EvalRunRow,
  evalResults,
  evalRuns,
  evalSuiteSettings,
  evals,
  evalTasks,
} from "@/lib/views/evals/schema";
import { generatedAfterEdit } from "../domain/edit";
import type { RunSettings, RunSettingsUsed } from "../domain/run-settings";
import {
  EVAL_TRANSCRIPT_TTL_DAYS,
  type Eval,
  type EvalChecks,
  type EvalResult,
  type EvalRun,
  type EvalSpecField,
  type EvalToolAnswer,
  type EvalTranscript,
  type EvalTurnResult,
  type EvalVerdict,
} from "../domain/types";
import type { EvalPatch, EvalStore, NewEval } from "../ports/store";

type Db = ReturnType<typeof getDb>;

const DAY_MS = 86_400_000;

/** The Postgres adapter of the eval store port. */
export function createDrizzleEvalStore(db: Db = getDb()): EvalStore {
  return {
    async createEval(input) {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(evals).values(newEvalRow(input)).returning();
        const tasks = [...new Set(input.tasks ?? [])].sort();
        if (tasks.length > 0)
          await tx
            .insert(evalTasks)
            .values(tasks.map((workflowId) => ({ evalId: row!.id, workflowId })));
        return toEval(row!, tasks);
      });
    },

    async importEvals(inputs) {
      if (inputs.length === 0) return 0;
      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(evals)
          .values(inputs.map(newEvalRow))
          .onConflictDoNothing({ target: [evals.projectId, evals.sourceCaseId] })
          .returning({ id: evals.id, sourceCaseId: evals.sourceCaseId });
        const tasksByCase = new Map(
          inputs.map((input) => [input.sourceCaseId, [...new Set(input.tasks ?? [])]]),
        );
        const links = rows.flatMap((row) =>
          (tasksByCase.get(row.sourceCaseId!) ?? []).map((workflowId) => ({
            evalId: row.id,
            workflowId,
          })),
        );
        if (links.length > 0) await tx.insert(evalTasks).values(links);
        return rows.length;
      });
    },

    async getEval(projectId, evalId) {
      const [row] = await db
        .select()
        .from(evals)
        .where(and(eq(evals.projectId, projectId), eq(evals.id, evalId)))
        .limit(1);
      if (!row) return null;
      return toEval(row, (await tasksOf(db, [row.id])).get(row.id) ?? []);
    },

    async listEvals(projectId, filter = {}) {
      const rows = await db
        .select()
        .from(evals)
        .where(
          and(
            eq(evals.projectId, projectId),
            filter.statuses ? inArray(evals.status, [...filter.statuses]) : undefined,
            filter.workflowId === undefined
              ? undefined
              : inArray(
                  evals.id,
                  db
                    .select({ id: evalTasks.evalId })
                    .from(evalTasks)
                    .where(eq(evalTasks.workflowId, filter.workflowId)),
                ),
          ),
        )
        .orderBy(asc(evals.createdAt), asc(evals.id));
      const tasks = await tasksOf(
        db,
        rows.map((row) => row.id),
      );
      return rows.map((row) => toEval(row, tasks.get(row.id) ?? []));
    },

    async setEvalStatus(projectId, evalId, status) {
      const rows = await db
        .update(evals)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(evals.projectId, projectId), eq(evals.id, evalId)))
        .returning({ id: evals.id });
      return rows.length > 0;
    },

    async updateEval(projectId, evalId, patch) {
      return db.transaction(async (tx) => {
        const specSet = specPatchOf(patch);
        const handSet = Object.keys(specSet);
        const [current] =
          handSet.length > 0
            ? await tx
                .select({ generated: evals.generated, edited: evals.edited })
                .from(evals)
                .where(and(eq(evals.projectId, projectId), eq(evals.id, evalId)))
            : [];
        const [row] = await tx
          .update(evals)
          .set({
            name: patch.name,
            earlierMessages: patch.earlierMessages,
            turns: patch.turns,
            checks: patch.checks as Record<string, { on: boolean; max?: number }>,
            expectedTool: patch.expectedTool,
            criteria: patch.criteria,
            fixedAnswers: patch.fixedAnswers,
            updatedAt: new Date(),
            ...specSet,
            // RC-642: an edit gives an eval without a spec one, so the edited field reaches its replay.
            ...(current
              ? {
                  generated: generatedAfterEdit(current.generated ?? [], handSet),
                  edited: [
                    ...new Set([...(current.edited ?? []), ...handSet]),
                  ].sort() as EvalSpecField[],
                }
              : {}),
          })
          .where(and(eq(evals.projectId, projectId), eq(evals.id, evalId)))
          .returning();
        if (!row) return null;
        const tasks = [...new Set(patch.tasks)].sort();
        await tx.delete(evalTasks).where(eq(evalTasks.evalId, evalId));
        if (tasks.length > 0)
          await tx.insert(evalTasks).values(tasks.map((workflowId) => ({ evalId, workflowId })));
        return toEval(row, tasks);
      });
    },

    async setEvalRunSettings(projectId, evalId, settings) {
      const [row] = await db
        .update(evals)
        .set({
          runSettings: Object.keys(settings).length > 0 ? settingsRow(settings) : null,
          updatedAt: new Date(),
        })
        .where(and(eq(evals.projectId, projectId), eq(evals.id, evalId)))
        .returning();
      return row ? toEval(row, (await tasksOf(db, [row.id])).get(row.id) ?? []) : null;
    },

    async setEvalOpening(projectId, evalId, opening) {
      const [row] = await db
        .update(evals)
        .set({
          opening:
            opening && opening.length > 0
              ? (opening as unknown as Record<string, unknown>[])
              : null,
          updatedAt: new Date(),
        })
        .where(and(eq(evals.projectId, projectId), eq(evals.id, evalId)))
        .returning();
      return row ? toEval(row, (await tasksOf(db, [row.id])).get(row.id) ?? []) : null;
    },

    async getSuiteRunSettings(projectId) {
      const [row] = await db
        .select({ runSettings: evalSuiteSettings.runSettings })
        .from(evalSuiteSettings)
        .where(eq(evalSuiteSettings.projectId, projectId))
        .limit(1);
      return (row?.runSettings ?? {}) as RunSettings;
    },

    async setSuiteRunSettings(projectId, settings, actor) {
      const runSettings = settingsRow(settings);
      await db
        .insert(evalSuiteSettings)
        .values({ projectId, runSettings, setBy: actor })
        .onConflictDoUpdate({
          target: evalSuiteSettings.projectId,
          set: { runSettings, setBy: actor, setAt: new Date() },
        });
      return settings;
    },

    async linkTasks(projectId, evalId, workflowIds) {
      if (!(await ownsEval(db, projectId, evalId))) return false;
      const unique = [...new Set(workflowIds)];
      if (unique.length > 0) {
        await db
          .insert(evalTasks)
          .values(unique.map((workflowId) => ({ evalId, workflowId })))
          .onConflictDoNothing();
      }
      return true;
    },

    async unlinkTask(projectId, evalId, workflowId) {
      if (!(await ownsEval(db, projectId, evalId))) return;
      await db
        .delete(evalTasks)
        .where(and(eq(evalTasks.evalId, evalId), eq(evalTasks.workflowId, workflowId)));
    },

    async createRun(input) {
      const [row] = await db
        .insert(evalRuns)
        .values({
          projectId: input.projectId,
          kind: input.kind,
          createdBy: input.createdBy,
          fixId: input.fixId ?? null,
          suite: input.suite ?? "",
          evalCount: input.evalCount ?? 0,
          ...(input.spend ? { spend: input.spend } : {}),
          ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        })
        .returning();
      return toRun(row!);
    },

    async getRun(projectId, runId) {
      const [row] = await db
        .select()
        .from(evalRuns)
        .where(and(eq(evalRuns.projectId, projectId), eq(evalRuns.id, runId)))
        .limit(1);
      return row ? toRun(row) : null;
    },

    async listRuns(projectId, filter = {}) {
      const rows = await db
        .select()
        .from(evalRuns)
        .where(
          and(
            eq(evalRuns.projectId, projectId),
            filter.kinds ? inArray(evalRuns.kind, [...filter.kinds]) : undefined,
            filter.fixId ? eq(evalRuns.fixId, filter.fixId) : undefined,
          ),
        )
        .orderBy(desc(evalRuns.createdAt), desc(evalRuns.id))
        .limit(filter.limit ?? 100);
      return rows.map(toRun);
    },

    async updateRun(projectId, runId, patch) {
      await db
        .update(evalRuns)
        .set(patch)
        .where(and(eq(evalRuns.projectId, projectId), eq(evalRuns.id, runId)));
    },

    async recordResults(projectId, runId, results) {
      const [run] = await db
        .select({ id: evalRuns.id })
        .from(evalRuns)
        .where(and(eq(evalRuns.projectId, projectId), eq(evalRuns.id, runId)))
        .limit(1);
      if (!run) throw new Error("eval run not found in project");
      if (results.length === 0) return;
      await db
        .insert(evalResults)
        .values(
          results.map((result) => ({
            projectId,
            runId,
            evalId: result.evalId,
            side: result.side ?? "before",
            passed: result.passed,
            verdicts: result.verdicts as unknown as Record<string, unknown>[],
            change: result.change ?? null,
            durationMs: result.durationMs ?? null,
            costUsd: result.costUsd ?? null,
            toolCalls: result.toolCalls ?? null,
            toolAnswers: (result.toolAnswers ?? []) as unknown as Record<string, unknown>[],
            transcript: (result.transcript ?? null) as Record<string, unknown> | null,
            turns: (result.turns ?? null) as unknown as Record<string, unknown>[] | null,
            attempts: result.attempts ?? null,
            generated: result.generated && result.generated.length > 0 ? result.generated : null,
            runSettings: (result.runSettings ?? null) as Record<string, unknown> | null,
            error: result.error ?? null,
            ...(result.createdAt ? { createdAt: result.createdAt } : {}),
          })),
        )
        .onConflictDoUpdate({
          target: [evalResults.runId, evalResults.evalId, evalResults.side],
          set: {
            passed: sql`excluded.passed`,
            verdicts: sql`excluded.verdicts`,
            change: sql`excluded.change`,
            durationMs: sql`excluded.duration_ms`,
            costUsd: sql`excluded.cost_usd`,
            toolCalls: sql`excluded.tool_calls`,
            toolAnswers: sql`excluded.tool_answers`,
            transcript: sql`excluded.transcript`,
            turns: sql`excluded.turns`,
            attempts: sql`excluded.attempts`,
            generated: sql`excluded.generated`,
            runSettings: sql`excluded.run_settings`,
            error: sql`excluded.error`,
          },
        });
    },

    async listResults(projectId, runId) {
      const rows = await db
        .select()
        .from(evalResults)
        .where(and(eq(evalResults.projectId, projectId), eq(evalResults.runId, runId)))
        .orderBy(asc(evalResults.createdAt), asc(evalResults.id));
      return rows.map(toResult);
    },

    async recentResults(projectId, evalIds, perEval) {
      const out = new Map<string, EvalResult[]>();
      if (evalIds.length === 0 || perEval <= 0) return out;
      const ranked = db
        .select({
          id: evalResults.id,
          rank: sql<number>`row_number() over (partition by ${evalResults.evalId} order by ${evalResults.createdAt} desc, ${evalResults.id} desc)`.as(
            "rank",
          ),
        })
        .from(evalResults)
        .innerJoin(evalRuns, eq(evalRuns.id, evalResults.runId))
        .where(
          and(
            eq(evalResults.projectId, projectId),
            inArray(evalResults.evalId, [...evalIds]),
            eq(evalRuns.status, "completed"),
            // RC-293: a simulation replays the agent with a fix, not the agent today.
            ne(evalRuns.kind, "simulation"),
          ),
        )
        .as("ranked");
      const rows = await db
        .select({ result: evalResults })
        .from(evalResults)
        .innerJoin(ranked, eq(ranked.id, evalResults.id))
        .where(sql`${ranked.rank} <= ${perEval}`)
        .orderBy(desc(evalResults.createdAt), desc(evalResults.id));
      for (const { result } of rows) {
        const list = out.get(result.evalId) ?? [];
        list.push(toResult(result));
        out.set(result.evalId, list);
      }
      return out;
    },

    async resultsForEval(projectId, evalId, limit) {
      const rows = await db
        .select({ run: evalRuns, result: evalResults })
        .from(evalResults)
        .innerJoin(evalRuns, eq(evalRuns.id, evalResults.runId))
        .where(and(eq(evalResults.projectId, projectId), eq(evalResults.evalId, evalId)))
        .orderBy(desc(evalRuns.createdAt), desc(evalResults.id))
        .limit(limit);
      return rows.map((row) => ({ run: toRun(row.run), result: toResult(row.result) }));
    },

    async runSummaries(projectId, runIds) {
      const out = new Map<
        string,
        { passed: number; total: number; nowFails: number; fixed: number }
      >();
      if (runIds.length === 0) return out;
      const rows = await db
        .select({
          runId: evalResults.runId,
          passed: sql<number>`count(*) filter (where ${evalResults.passed})::int`,
          total: sql<number>`count(*)::int`,
          nowFails: sql<number>`count(*) filter (where ${evalResults.change} = 'now_fails')::int`,
          fixed: sql<number>`count(*) filter (where ${evalResults.change} = 'fixed')::int`,
        })
        .from(evalResults)
        .where(and(eq(evalResults.projectId, projectId), inArray(evalResults.runId, [...runIds])))
        .groupBy(evalResults.runId);
      for (const { runId, ...summary } of rows) out.set(runId, summary);
      return out;
    },

    // RC-318: each turn's message is customer text too; the turn's verdicts and numbers stay.
    async pruneTranscripts(now = new Date()) {
      const hasTurnText = sql`jsonb_path_exists(${evalResults.turns}, '$[*] ? (@.message != null)')`;
      const cleared = await db
        .update(evalResults)
        .set({
          transcript: null,
          turns: sql`case when ${hasTurnText} then (select jsonb_agg(turn || '{"message": null}'::jsonb order by n) from jsonb_array_elements(${evalResults.turns}) with ordinality as t(turn, n)) else ${evalResults.turns} end`,
        })
        .where(
          and(
            or(isNotNull(evalResults.transcript), hasTurnText),
            lt(evalResults.createdAt, new Date(now.getTime() - EVAL_TRANSCRIPT_TTL_DAYS * DAY_MS)),
          ),
        )
        .returning({ id: evalResults.id });
      return cleared.length;
    },
  };
}

function newEvalRow(input: NewEval): typeof evals.$inferInsert {
  return {
    projectId: input.projectId,
    name: input.name,
    message: input.message,
    origin: input.origin,
    createdBy: input.createdBy,
    status: input.status ?? "suggested",
    sourceTurnId: input.sourceTurnId ?? null,
    sourceCaseId: input.sourceCaseId ?? null,
    earlierMessages: input.earlierMessages ?? [],
    turns: input.turns ?? [],
    checks: input.checks ?? {},
    expectedTool: input.expectedTool ?? null,
    criteria: input.criteria ?? "",
    fixedAnswers: input.fixedAnswers ?? [],
    ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.generated !== undefined ? { generated: input.generated } : {}),
    ...(input.edited !== undefined && input.edited.length > 0 ? { edited: input.edited } : {}),
    ...(input.suggestionReason !== undefined ? { suggestionReason: input.suggestionReason } : {}),
    ...(input.runSettings !== undefined && Object.keys(input.runSettings).length > 0
      ? { runSettings: settingsRow(input.runSettings) }
      : {}),
    ...(input.opening && input.opening.length > 0
      ? { opening: input.opening as unknown as Record<string, unknown>[] }
      : {}),
  };
}

/** RC-653: run settings as the jsonb column holds them. */
function settingsRow(settings: RunSettings): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as Record<string, string | number>;
}

async function tasksOf(db: Db, evalIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (evalIds.length === 0) return out;
  const rows = await db
    .select()
    .from(evalTasks)
    .where(inArray(evalTasks.evalId, [...evalIds]))
    .orderBy(asc(evalTasks.workflowId));
  for (const row of rows) out.set(row.evalId, [...(out.get(row.evalId) ?? []), row.workflowId]);
  return out;
}

async function ownsEval(db: Db, projectId: string, evalId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: evals.id })
    .from(evals)
    .where(and(eq(evals.projectId, projectId), eq(evals.id, evalId)))
    .limit(1);
  return row !== undefined;
}

function toEval(row: EvalRow, tasks: string[]): Eval {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    sourceTurnId: row.sourceTurnId,
    sourceCaseId: row.sourceCaseId,
    message: row.message,
    earlierMessages: row.earlierMessages,
    turns: row.turns.map((turn) =>
      typeof turn === "string" ? { kind: "message" as const, text: turn } : turn,
    ),
    checks: row.checks as EvalChecks,
    expectedTool: row.expectedTool,
    criteria: row.criteria,
    fixedAnswers: row.fixedAnswers,
    // RC-608: only on rows that have a spec, so an eval made with the gate off reads as before.
    ...(row.systemPrompt !== null ? { systemPrompt: row.systemPrompt } : {}),
    ...(row.tools !== null ? { tools: row.tools } : {}),
    ...(row.context !== null ? { context: row.context } : {}),
    ...(row.generated !== null ? { generated: row.generated } : {}),
    ...(row.edited !== null ? { edited: row.edited } : {}),
    ...(row.suggestionReason !== null ? { suggestionReason: row.suggestionReason } : {}),
    ...(row.runSettings !== null ? { runSettings: row.runSettings as RunSettings } : {}),
    ...(row.opening !== null
      ? { opening: row.opening as unknown as NonNullable<Eval["opening"]> }
      : {}),
    status: row.status,
    origin: row.origin,
    tasks,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRun(row: EvalRunRow): EvalRun {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    fixId: row.fixId,
    suite: row.suite,
    status: row.status,
    spend: row.spend,
    evalCount: row.evalCount,
    error: row.error,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function toResult(row: EvalResultRow): EvalResult {
  return {
    id: row.id,
    projectId: row.projectId,
    runId: row.runId,
    evalId: row.evalId,
    side: row.side,
    passed: row.passed,
    verdicts: row.verdicts as unknown as EvalVerdict[],
    change: row.change,
    durationMs: row.durationMs,
    costUsd: row.costUsd,
    toolCalls: row.toolCalls,
    toolAnswers: row.toolAnswers as unknown as EvalToolAnswer[],
    transcript: row.transcript as EvalTranscript | null,
    turns: row.turns as unknown as EvalTurnResult[] | null,
    attempts: row.attempts ?? null,
    // RC-609: only on runs that used generated inputs, so other results read as before.
    ...(row.generated ? { generated: row.generated } : {}),
    // RC-653: only on results that recorded their settings, so older results read as before.
    ...(row.runSettings ? { runSettings: row.runSettings as unknown as RunSettingsUsed } : {}),
    error: row.error,
    createdAt: row.createdAt,
  };
}

/** RC-614, RC-641: the spec fields an edit gives. */
function specPatchOf(
  patch: EvalPatch,
): Partial<Pick<typeof evals.$inferInsert, "message" | "systemPrompt" | "tools" | "context">> {
  return {
    ...(patch.message !== undefined ? { message: patch.message } : {}),
    ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt } : {}),
    ...(patch.tools !== undefined ? { tools: patch.tools } : {}),
    ...(patch.context !== undefined ? { context: patch.context } : {}),
  };
}
