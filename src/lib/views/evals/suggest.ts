import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  defaultOrganizationFlagDeps,
  type OrganizationFlagDeps,
} from "@/lib/platform/organization-flags";
import { loadAsksByTurn } from "@/lib/readings/trace-signals/workflows/label-queries";
import { evals } from "@/lib/views/evals/schema";
import { foreignProjectsOfRuns } from "@/lib/views/task-evals/foreign-project";
import { type TaskEvalCaseRow, taskEvalCases } from "@/lib/views/task-evals/schema";
import { createDrizzleEvalStore } from "./adapters/drizzle-store";
import type { EvalStatus } from "./domain/types";
import { type CapturedSpec, loadCapturedSpecs } from "./fill/captured";
import { resolveSpecFiller, type SpecFiller } from "./fill/filler";
import { completeSpec } from "./fill/spec";
import { EVALS_OFF_ERROR, evalsEnabledForActor } from "./gate";
import type { NewEval } from "./ports/store";
import type { ActionResult } from "./run";
import { type Candidate, type KnownEval, pickCandidates } from "./suggest/candidates";
import { loadLowRuns, loadRunPaths, type RunPath } from "./suggest/readings";

/**
 * RC-290: how the eval set fills from tasks, with no model call. Each task
 * suggests at most 5 evals from its automatic and issue cases (Q2). RC-315: a
 * suggestion joins the eval set at once and runs with it; its status stays
 * `suggested` as its label. There is no project cap (RC-322). Pinned and user cases are a person's choice already, so they
 * import as approved evals. A case becomes an eval once
 * (`evals.source_case_id`), so a removed suggestion never returns.
 *
 * RC-616: with the eval gate on, a task's suggestions come only from runs a
 * scorer read under its good threshold, worst first, with no near-duplicate
 * of each other or of an eval the task has (see `suggest/candidates.ts`).
 * Each names the reading that made it. A run makes an eval once
 * (`evals.source_turn_id`), so a removed suggestion never returns.
 */

export const MAX_SUGGESTIONS_PER_TASK = 5;
const ACTOR = "system:evals";
const NAME_CHARS = 80;
const logger = getLogger("evals/suggest");

export interface SuggestDeps {
  db?: ReturnType<typeof getDb>;
  /** The captured ask of each turn. */
  loadAsks?: (projectId: string, turnIds: readonly string[]) => Promise<Map<string, string>>;
  /** RC-608: decides the eval gate for the spec fill. */
  flagDeps?: OrganizationFlagDeps;
  /** RC-608: writes the spec fields a recording lacks. Absent: the deployment's filler; null: none. */
  filler?: SpecFiller | null;
  /** RC-608: each turn's captured spec. */
  loadCaptured?: (
    projectId: string,
    turnIds: readonly string[],
  ) => Promise<Map<string, CapturedSpec>>;
  /** RC-616: each run's tool path and end. */
  loadRunPaths?: (projectId: string, turnIds: readonly string[]) => Promise<Map<string, RunPath>>;
}

/** Fill a task's free suggestion slots. Returns how many suggestions were added. */
export async function suggestTaskEvals(
  projectId: string,
  workflowId: string,
  deps: SuggestDeps = {},
): Promise<number> {
  const db = deps.db ?? getDb();
  const store = createDrizzleEvalStore(db);
  const open = (await store.listEvals(projectId, { workflowId, statuses: ["suggested"] })).length;
  const slots = MAX_SUGGESTIONS_PER_TASK - open;
  if (slots <= 0) return 0;
  if (
    await evalsEnabledForActor(projectId, ACTOR, db, deps.flagDeps ?? defaultOrganizationFlagDeps)
  ) {
    return suggestFromScores(projectId, workflowId, slots, deps, db);
  }
  const cases = await db
    .select()
    .from(taskEvalCases)
    .where(
      and(
        eq(taskEvalCases.projectId, projectId),
        eq(taskEvalCases.taskId, workflowId),
        isNull(taskEvalCases.fixId),
        isNull(taskEvalCases.excludedAt),
        eq(taskEvalCases.pinned, false),
        inArray(taskEvalCases.origin, ["auto", "issue"]),
        notImported(projectId),
      ),
    )
    .orderBy(
      sql`case when ${taskEvalCases.origin} = 'issue' then 0 else 1 end`,
      asc(taskEvalCases.id),
    )
    .limit(slots);
  const added = await store.importEvals(await evalsFrom(projectId, cases, "suggested", deps, db));
  if (added > 0)
    logger.info(
      { project_id: projectId, workflow_id: workflowId, added },
      "eval_suggestions_added",
    );
  return added;
}

/** RC-616: fill the free slots with the worst-scoring runs of the task that no eval covers yet. */
async function suggestFromScores(
  projectId: string,
  workflowId: string,
  slots: number,
  deps: SuggestDeps,
  db: ReturnType<typeof getDb>,
): Promise<number> {
  const lowRuns = await loadLowRuns(projectId, workflowId, db);
  if (lowRuns.length === 0) return 0;
  const store = createDrizzleEvalStore(db);
  const existing = await store.listEvals(projectId, { workflowId });
  const sourceTurns = existing.flatMap((item) => (item.sourceTurnId ? [item.sourceTurnId] : []));
  const turnIds = lowRuns.map((run) => run.turnId);
  const paths = await (deps.loadRunPaths ?? ((id, ids) => loadRunPaths(id, ids, db)))(projectId, [
    ...turnIds,
    ...sourceTurns,
  ]);
  const asks = await (deps.loadAsks ?? ((id, ids) => loadAsksByTurn(id, ids, db)))(
    projectId,
    turnIds,
  );
  const candidates: Candidate[] = lowRuns.map((run) => ({
    turnId: run.turnId,
    ask: asks.get(run.turnId) ?? "",
    lows: run.lows,
    toolPath: paths.get(run.turnId)?.toolPath ?? [],
    endedAt: paths.get(run.turnId)?.endedAt ?? run.scoredAt,
  }));
  const own = await withoutForeignRuns(projectId, workflowId, candidates, db);
  // An eval's failing scorers are not kept, so they match any; its tool path is its source run's, when known.
  const known: KnownEval[] = existing.map((item) => ({
    message: item.message,
    scorerIds: null,
    toolPath: item.sourceTurnId ? (paths.get(item.sourceTurnId)?.toolPath ?? null) : null,
  }));
  const picks = pickCandidates(own, known, slots);
  const drafts = picks.map(({ candidate, reason }) => ({
    projectId,
    status: "suggested" as const,
    origin: "auto" as const,
    createdBy: ACTOR,
    sourceTurnId: candidate.turnId,
    message: candidate.ask,
    name: candidate.ask
      ? candidate.ask.slice(0, NAME_CHARS)
      : `Run ${candidate.turnId.slice(0, 8)}`,
    tasks: [workflowId],
    suggestionReason: reason,
  }));
  let added = 0;
  for (const draft of await withSpecs(projectId, drafts, deps, db)) {
    await store.createEval(draft);
    added++;
  }
  if (added > 0)
    logger.info(
      { project_id: projectId, workflow_id: workflowId, added, candidates: candidates.length },
      "eval_suggestions_added_from_scores",
    );
  return added;
}

/** RC-853: drop the runs that work on a project of another organization (`lib/task-evals/foreign-project.ts`). */
async function withoutForeignRuns(
  projectId: string,
  workflowId: string,
  candidates: readonly Candidate[],
  db: ReturnType<typeof getDb>,
): Promise<Candidate[]> {
  const foreign = await foreignProjectsOfRuns(
    projectId,
    candidates.map(({ turnId, ask }) => ({ turnId, ask })),
    db,
  );
  const kept = candidates.filter((candidate) => !foreign.has(candidate.turnId));
  const skipped = candidates.length - kept.length;
  if (skipped > 0)
    logger.warn(
      { project_id: projectId, workflow_id: workflowId, skipped, reason: "foreign_project" },
      "skipped runs of another organization as eval suggestions",
    );
  return kept;
}

/** Import every pinned or user case of the project as an approved eval. Idempotent. */
export async function importTaskCases(projectId: string, deps: SuggestDeps = {}): Promise<number> {
  const db = deps.db ?? getDb();
  const cases = await db
    .select()
    .from(taskEvalCases)
    .where(
      and(
        eq(taskEvalCases.projectId, projectId),
        isNull(taskEvalCases.fixId),
        isNull(taskEvalCases.excludedAt),
        or(eq(taskEvalCases.pinned, true), eq(taskEvalCases.origin, "user")),
        notImported(projectId),
      ),
    )
    .orderBy(asc(taskEvalCases.taskId), asc(taskEvalCases.id));
  const added = await createDrizzleEvalStore(db).importEvals(
    await evalsFrom(projectId, cases, "approved", deps, db),
  );
  if (added > 0) logger.info({ project_id: projectId, added }, "eval_cases_imported");
  return added;
}

export interface RemoveEvalDeps {
  db?: ReturnType<typeof getDb>;
  flagDeps?: OrganizationFlagDeps;
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: { id: string }; organization: { id: string } } | null>;
  track?: (event: {
    externalId: string;
    projectId: string;
    organizationId: string;
    evalId: string;
  }) => Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Remove an eval from the set: archived, out of every run, and a suggestion never returns. */
export async function removeEval(
  projectId: string,
  evalId: string,
  deps: RemoveEvalDeps,
): Promise<ActionResult<EvalStatus>> {
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to remove evals." };
  const scope = UUID.test(projectId)
    ? await deps.findProjectScope(projectId, session.user.id)
    : null;
  if (!scope) return { ok: false, error: "No project you belong to has that ID." };
  const db = deps.db ?? getDb();
  const actor = session.user.externalId;
  if (
    !(await evalsEnabledForActor(
      scope.project.id,
      actor,
      db,
      deps.flagDeps ?? defaultOrganizationFlagDeps,
    ))
  )
    return { ok: false, error: EVALS_OFF_ERROR };
  const store = createDrizzleEvalStore(db);
  const item = UUID.test(evalId) ? await store.getEval(scope.project.id, evalId) : null;
  if (!item || item.status === "archived")
    return { ok: false, error: "No eval in this project has that ID." };
  await store.setEvalStatus(scope.project.id, evalId, "archived");
  logger.info({ project_id: scope.project.id, eval_id: evalId, actor }, "eval_removed");
  await deps.track?.({
    externalId: actor,
    projectId: scope.project.id,
    organizationId: scope.organization.id,
    evalId,
  });
  return { ok: true, value: "archived" };
}

/** The case has no eval in the project yet (any status: a dismissed one counts). */
function notImported(projectId: string) {
  return sql`${taskEvalCases.id} not in (select ${evals.sourceCaseId} from ${evals} where ${evals.projectId} = ${projectId} and ${evals.sourceCaseId} is not null)`;
}

async function evalsFrom(
  projectId: string,
  cases: readonly TaskEvalCaseRow[],
  status: EvalStatus,
  deps: SuggestDeps,
  db: ReturnType<typeof getDb>,
): Promise<(NewEval & { sourceCaseId: string })[]> {
  if (cases.length === 0) return [];
  const needAsk = cases.filter((item) => !item.testAsk).map((item) => item.turnId);
  const asks =
    needAsk.length > 0
      ? await (deps.loadAsks ?? ((id, turnIds) => loadAsksByTurn(id, turnIds, db)))(
          projectId,
          needAsk,
        )
      : new Map<string, string>();
  const drafts = cases.map((item) => {
    const message = item.testAsk ?? asks.get(item.turnId) ?? "";
    return {
      projectId,
      status,
      origin: item.origin,
      createdBy: ACTOR,
      sourceCaseId: item.id,
      sourceTurnId: item.turnId,
      message,
      name:
        item.testName ??
        (message ? message.slice(0, NAME_CHARS) : `Run ${item.turnId.slice(0, 8)}`),
      criteria: item.criteria,
      expectedTool: typeof item.expected.tool === "string" ? item.expected.tool : null,
      tasks: [item.taskId],
    };
  });
  if (
    !(await evalsEnabledForActor(
      projectId,
      ACTOR,
      db,
      deps.flagDeps ?? defaultOrganizationFlagDeps,
    ))
  )
    return drafts;
  return withSpecs(projectId, drafts, deps, db);
}

/**
 * RC-608: each draft with a complete spec: the recording's values, and what
 * the filler writes for the rest. A recording that can't be read fills nothing.
 */
async function withSpecs<T extends NewEval & { sourceTurnId: string }>(
  projectId: string,
  drafts: T[],
  deps: SuggestDeps,
  db: ReturnType<typeof getDb>,
): Promise<T[]> {
  let captured: Map<string, CapturedSpec>;
  try {
    captured = await (deps.loadCaptured ?? ((id, turnIds) => loadCapturedSpecs(id, turnIds, db)))(
      projectId,
      drafts.map((draft) => draft.sourceTurnId),
    );
  } catch (err) {
    logger.warn({ err, project_id: projectId }, "eval spec recording read failed");
    return drafts;
  }
  const filler = deps.filler === undefined ? resolveSpecFiller() : deps.filler;
  return Promise.all(
    drafts.map(async (draft) => {
      const spec = await completeSpec(
        {
          name: draft.name,
          message: draft.message,
          criteria: draft.criteria ?? "",
          expectedTool: draft.expectedTool ?? null,
          earlierMessages: draft.earlierMessages ?? [],
          captured: captured.get(draft.sourceTurnId) ?? null,
        },
        filler,
      );
      if (spec.generated.length > 0)
        logger.info(
          { project_id: projectId, source_turn_id: draft.sourceTurnId, generated: spec.generated },
          "eval spec filled",
        );
      return { ...draft, ...spec };
    }),
  );
}
