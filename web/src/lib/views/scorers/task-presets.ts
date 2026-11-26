import { and, eq, gte, isNotNull, notExists, sql } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import {
  resetScorer,
  type ScorerInput,
  scorersFor,
  upsertScorer,
} from "@/lib/views/task-scorers/store";
import type { ScorerKind as TaskKind, Scorer as TaskScorer } from "@/lib/views/task-scorers/types";
import { MAX_NAME_CHARS, MAX_SCORERS, TASK_SCORERS_ACTOR } from "./config";
import { limitText } from "./format";
import { definitionOf } from "./preset";
import { taskPresetSeeds } from "./schema";
import {
  countScorers,
  createScorer,
  detachScorer,
  listTaskScorers,
  type ScorerDb,
  updateScorer,
} from "./store";
import type { Scorer, ScorerDraft } from "./types";

export { TASK_SCORERS_ACTOR };

/** The record of a task that got its defaults (`task_preset_seeds.kind`). */
const SEEDED = "*";
const DAY_MS = 86_400_000;
/** The tasks seen this recently get their default presets. */
const RECENT_DAYS = 7;
/** Tasks one call seeds. The rest wait for the next call. */
const MAX_TASKS_PER_CALL = 50;

const logger = getLogger("scorers/seed");

/**
 * Give each recent task of the project its task scorers as scorers of the one model, once: the
 * defaults measured from its own runs, with the settings a person stored (`task-scorers/store.ts#scorersFor`).
 * A kind the task already has attached, or that was given before (migration 0055 records each kind it
 * converted), is left out. The task and each of its kinds are recorded when it is done, so a preset
 * that a person later detaches or deletes does not come back. These scorers are the system's
 * (`TASK_SCORERS_ACTOR`): they do not count against `MAX_SCORERS`, so the seed never takes a slot
 * of a person. Returns the scorers it created.
 */
export async function seedTaskPresets(
  projectId: string,
  now: Date = new Date(),
  db: ScorerDb & EvalDb = getDb(),
): Promise<number> {
  const tasks = await db
    .selectDistinct({ taskId: traceTurns.workflowId })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.status, "closed"),
        isNotNull(traceTurns.workflowId),
        gte(traceTurns.endedAt, new Date(now.getTime() - RECENT_DAYS * DAY_MS)),
        notExists(
          db
            .select({ taskId: taskPresetSeeds.taskId })
            .from(taskPresetSeeds)
            .where(
              and(
                eq(taskPresetSeeds.projectId, projectId),
                eq(taskPresetSeeds.taskId, sql`${traceTurns.workflowId}`),
                eq(taskPresetSeeds.kind, SEEDED),
              ),
            ),
        ),
      ),
    )
    .orderBy(traceTurns.workflowId)
    .limit(MAX_TASKS_PER_CALL);
  let created = 0;
  for (const { taskId } of tasks) {
    if (taskId === null) continue;
    const [attached, given, effective] = await Promise.all([
      listTaskScorers(projectId, taskId, db),
      givenKinds(projectId, taskId, db),
      scorersFor(projectId, taskId, db),
    ]);
    const missing = effective.filter(
      (scorer) =>
        !given.has(scorer.kind) && !attached.some((current) => standsFor(current, scorer)),
    );
    await db.transaction(async (tx) => {
      for (const scorer of missing)
        await createScorer(projectId, draftOf(scorer, taskId), TASK_SCORERS_ACTOR, tx);
      await tx
        .insert(taskPresetSeeds)
        .values(
          [SEEDED, ...effective.map((scorer) => scorer.kind)].map((kind) => ({
            projectId,
            taskId,
            kind,
          })),
        )
        .onConflictDoNothing();
    });
    created += missing.length;
  }
  return created;
}

/** A change refused because its scorer of the one model would pass the limit (flag on only). */
export class ScorerLimitError extends Error {
  constructor(count: number) {
    super(limitText(count, MAX_SCORERS).text);
    this.name = "ScorerLimitError";
  }
}

/**
 * Save a task scorer (`task_scorers`, what the eval gate grades with) and move its scorer of the one
 * model with it: the task page and MCP `change_task_scorer` save through here, so the scorers that
 * migration 0055 converted never go stale. `live` is the `customMonitoring` flag of the project.
 * Off, the save is the result, as before the one model: the sync runs when it can, and one the limit
 * refuses is logged, not an error. On, a change whose scorer would have to be created past the limit
 * is refused before any write (`ScorerLimitError`).
 */
export async function saveTaskScorer(
  input: ScorerInput,
  live: boolean,
  db: ScorerDb & EvalDb = getDb(),
): Promise<void> {
  const { projectId, taskId, scorer, updatedBy } = input;
  await withSync(
    { projectId, taskId, kind: scorer.kind, next: scorer, actor: updatedBy, live },
    db,
    () => upsertScorer(input, db),
  );
}

/** Reset a task scorer to its default (`resetScorer`), and move its scorer of the one model with it, as `saveTaskScorer`. */
export async function resetTaskScorer(
  projectId: string,
  taskId: string,
  kind: TaskKind,
  actor: string,
  live: boolean,
  db: ScorerDb & EvalDb = getDb(),
): Promise<void> {
  await withSync({ projectId, taskId, kind, actor, live }, db, () =>
    resetScorer(projectId, taskId, kind, db),
  );
}

/**
 * Make the task's scorer of the one model follow a change of its task scorer: `before` and `after` are the task's effective scorer of that kind
 * (`scorersFor`) around the change. The attached scorer that stood for `before` takes the new
 * setting and switch, keeping its name, filter, sample and tasks; without one, a scorer is created,
 * under the limit. Without `after` (a reset to no default), it is detached from the task. False when
 * the limit stops a create.
 */
export async function syncTaskPreset(
  projectId: string,
  taskId: string,
  before: TaskScorer | undefined,
  after: (TaskScorer & { enabled: boolean }) | undefined,
  actor: string,
  db: ScorerDb & EvalDb = getDb(),
): Promise<boolean> {
  const wanted = before ?? after;
  if (!wanted) return true;
  const current = (await listTaskScorers(projectId, taskId, db)).find((scorer) =>
    standsFor(scorer, wanted),
  );
  if (!after) {
    if (current) await detachScorer(projectId, current.id, taskId, actor, db);
    return true;
  }
  if (current) {
    const { name, filter, tasks, sampleRate } = current;
    await updateScorer(
      projectId,
      current.id,
      { ...definitionOf(after), name, filter, tasks, sampleRate, enabled: after.enabled },
      actor,
      db,
    );
    return true;
  }
  if ((await countScorers(projectId, db)) >= MAX_SCORERS) return false;
  await createScorer(projectId, draftOf(after, taskId), actor, db);
  return true;
}

/**
 * Run a write of one task scorer, then sync its scorer of the one model from the effective scorer
 * before and after. With `live`, a write whose scorer is not attached yet, in a project at or over
 * the limit, is refused first.
 */
async function withSync(
  change: {
    projectId: string;
    taskId: string;
    kind: TaskKind;
    /** What a save stores; none for a reset. */
    next?: TaskScorer;
    actor: string;
    live: boolean;
  },
  db: ScorerDb & EvalDb,
  write: () => Promise<unknown>,
): Promise<void> {
  const { projectId, taskId, kind, next, actor, live } = change;
  const effective = async () =>
    (await scorersFor(projectId, taskId, db)).find((scorer) => scorer.kind === kind);
  const before = await effective();
  if (live && (before || next)) {
    const attached = await listTaskScorers(projectId, taskId, db);
    const covered = attached.some(
      (scorer) => (before && standsFor(scorer, before)) || (next && standsFor(scorer, next)),
    );
    const count = covered ? 0 : await countScorers(projectId, db);
    if (count >= MAX_SCORERS) throw new ScorerLimitError(count);
  }
  await write();
  if (!(await syncTaskPreset(projectId, taskId, before, await effective(), actor, db)))
    logger.warn(
      { project_id: projectId, task_id: taskId, kind },
      "task scorer saved; its scorer waits for room under the scorer limit",
    );
}

/** The kinds of a task already given to the one model. */
async function givenKinds(
  projectId: string,
  taskId: string,
  db: Pick<ScorerDb, "select">,
): Promise<Set<string>> {
  const rows = await db
    .select({ kind: taskPresetSeeds.kind })
    .from(taskPresetSeeds)
    .where(and(eq(taskPresetSeeds.projectId, projectId), eq(taskPresetSeeds.taskId, taskId)));
  return new Set(rows.map((row) => row.kind));
}

/** A new scorer of one task for a task scorer. */
function draftOf(scorer: TaskScorer & { enabled: boolean }, taskId: string): ScorerDraft {
  return {
    ...definitionOf(scorer),
    name: `${SCORER_LABELS[scorer.kind]} · ${taskId}`.slice(0, MAX_NAME_CHARS),
    filter: {},
    tasks: [taskId],
    sampleRate: 100,
    enabled: scorer.enabled,
  };
}

/** Whether an attached scorer already does what this task scorer does. */
function standsFor(current: Scorer, scorer: TaskScorer): boolean {
  if (scorer.kind === "judge_criteria")
    return current.kind === "judge" && current.config.prompt === scorer.criteria;
  return current.kind === "preset" && current.config.preset === scorer.kind;
}
