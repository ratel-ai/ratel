import { and, eq, sql } from "drizzle-orm";
import type { JobHandler } from "@/lib/contracts/registry";
import { markJobDone } from "@/lib/jobs/queries";
import { drainJobs, type JobKind, type JobStore } from "@/lib/jobs/runner";
import { jobs } from "@/lib/jobs/schema";
import type { getDb } from "@/lib/platform/db/client";
import { getOrganizationById } from "@/lib/platform/organizations";
import { changeOf, hasEffect } from "@/lib/views/eval-gate/change";
import { standInModels } from "@/lib/views/eval-gate/models";
import { draftFixJob } from "@/lib/views/fix-drafts/job";
import { DEFAULT_DRAFT_MODEL, type DraftModel } from "@/lib/views/fix-drafts/model";
import { loadFixes } from "@/lib/views/fixes/load";
import { createFixShipment } from "@/lib/views/fixes/loop-queries";
import { fixShipments } from "@/lib/views/fixes/schema";
import type { Fix } from "@/lib/views/fixes/types";
import {
  enqueueDueTaskEvalSets,
  enqueueTaskEvalRefreshJob,
  refreshTaskEvalSetJob,
} from "@/lib/views/task-evals/job";
import { taskEvalRuns } from "@/lib/views/task-evals/schema";
import "@/lib/views/task-evals/ship";
import { runTaskSimulation, type TaskSimulationDeps } from "@/lib/views/task-evals/simulation";
import { simulateTaskEvalJob } from "@/lib/views/task-evals/simulation-job";
import { scoreTasksJob } from "@/lib/views/task-scorers/job";
import { scorersFor, upsertScorer } from "@/lib/views/task-scorers/store";

/**
 * The task loop demo, run through the production jobs on a seeded project: 14 UTC days of live
 * scores, the eval sets, a draft, two fix simulations and a shipment dated eight days ago with
 * its post-ship measure. Owned (ADR-0030): upstream's `lib/seed/task-loop.ts`. The gates are
 * `FF_STAGE_SPINE` and `FF_EVAL_GATE` (set here, as upstream sets its Cloud flags); a job runs
 * as one row through this repository's runner, which is the part of upstream's
 * `lib/seed/pipeline-runner.ts` (excluded) the demo needs (`runStep`, `resolveProject`); the
 * organization comes from the session port.
 */

type Db = ReturnType<typeof getDb>;
export interface TaskLoopSeedOptions {
  noModels?: boolean;
  now?: Date;
  loadFixes?: (projectId: string) => Promise<Fix[]>;
  out?: (line: string) => void;
}
const DAY_MS = 86_400_000;
const ACTOR = "system:task-loop-demo";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Run the demo through the production jobs. This function accepts test data only. */
export async function seedTaskLoop(db: Db, ref: string, options: TaskLoopSeedOptions = {}) {
  process.env.FF_STAGE_SPINE = "true";
  process.env.FF_EVAL_GATE = "true";
  const project = await resolveProject(db, ref);
  const now = options.now ?? new Date();
  const out = options.out ?? (() => undefined);
  const tasks = (
    await db.execute<{ id: string; runs: number }>(sql`
    select workflow_id as id, count(*)::int as runs from trace_turns
    where project_id = ${project.id} and status = 'closed' and workflow_id is not null and ended_at <= ${now}
    group by workflow_id order by count(*) desc, workflow_id`)
  ).rows;
  const task = tasks[0];
  if (!task)
    throw new Error("The project has no tasks. Run pnpm seed --drain for the project first.");
  const fixes = await (options.loadFixes ?? ((id) => projectFixes(id, project, db, now)))(
    project.id,
  );
  const simulatable = fixes.filter(
    (fix) =>
      fix.subject.tasks.length > 0 &&
      (hasEffect(changeOf(fix)) || fix.kind === "rewrite" || fix.kind === "tell-apart"),
  );
  const top = simulatable.find((fix) => fix.subject.tasks.some((item) => item.id === task.id));
  if (!top)
    throw new Error(
      "The top task has no supported fix. Seed Site Copilot and drain its pipeline first.",
    );
  // Use another fix for the earlier release. Prefer a fix on the top task.
  const alternatives = [...simulatable].reverse().filter((fix) => fix.id !== top.id);
  const older =
    alternatives.find(
      (fix) => fix.appliedAt && fix.subject.tasks.some((item) => item.id === task.id),
    ) ??
    alternatives.find((fix) => fix.subject.tasks.some((item) => item.id === task.id)) ??
    alternatives.find((fix) => fix.appliedAt) ??
    alternatives[0];
  if (!older) throw new Error("The demo needs two supported fixes with tasks.");
  const deps: TaskSimulationDeps = {
    db,
    now: () => now,
    loadFix: async (_projectId, fixId) => {
      const fix = fixes.find((item) => item.id === fixId);
      return fix ? { projectId: project.id, fix } : null;
    },
    ...(options.noModels ? { models: standInModels() } : {}),
  };
  // Preserve an existing user scorer. New demo criteria exercise the judge in simulations.
  for (const item of tasks) {
    if (
      !(await scorersFor(project.id, item.id, db)).some(
        (scorer) => scorer.kind === "judge_criteria",
      )
    ) {
      await upsertScorer(
        {
          projectId: project.id,
          taskId: item.id,
          scorer: {
            kind: "judge_criteria",
            criteria: "Complete the requested task without ending on a failed tool call.",
          },
          source: "default",
          updatedBy: ACTOR,
        },
        db,
      );
    }
  }
  for (let offset = 13; offset >= 0; offset--) {
    const day = new Date(now.getTime() - offset * DAY_MS);
    if (offset > 0) day.setUTCHours(23, 59, 59, 999);
    await step("score_tasks", () =>
      scoreTasksJob(project.id, {
        ...deps,
        now: () => day,
        ...(options.noModels ? { judge: null } : {}),
      }),
    );
  }
  await enqueueDueTaskEvalSets(project.id, { db, now: () => now });
  for (const item of tasks) await enqueueTaskEvalRefreshJob(project.id, item.id, { db });
  const refreshes = await queued("refresh_task_eval_set");
  for (const job of refreshes)
    await step(
      "refresh_task_eval_set",
      (record) => refreshTaskEvalSetJob(project.id, record.payload, deps),
      job.id,
    );
  out("Scored 14 UTC days and refreshed task eval sets.");
  await simulate(top);
  await simulate(older);
  const shippedAt = new Date(now.getTime() - 8 * DAY_MS);
  const version = "task-loop-demo-v1";
  const [existing] = await db
    .select()
    .from(fixShipments)
    .where(
      and(
        eq(fixShipments.projectId, project.id),
        eq(fixShipments.fixId, older.id),
        eq(fixShipments.version, version),
      ),
    )
    .limit(1);
  const shipment =
    existing ??
    (await createFixShipment(
      {
        projectId: project.id,
        fixId: older.id,
        insightId: null,
        experimentId: null,
        version,
        notes: "Demo shipment dated eight days ago. Measured on later recorded runs.",
        shippedBy: ACTOR,
      },
      db,
      { ...deps, now: () => shippedAt },
    ));
  const measures = await db
    .select()
    .from(taskEvalRuns)
    .where(
      and(
        eq(taskEvalRuns.projectId, project.id),
        eq(taskEvalRuns.shipmentId, shipment.id),
        eq(taskEvalRuns.kind, "post_ship"),
      ),
    );
  if (!measures.length) throw new Error("The demo shipment has no post-ship measurement.");
  for (const measure of measures) {
    if (measure.status === "completed") {
      if (measure.caseCount === 0)
        throw new Error("The demo needs recorded runs after the shipment date.");
      continue;
    }
    const [job] = await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.projectId, project.id),
          eq(jobs.kind, "simulate_task_eval"),
          eq(jobs.status, "queued"),
          sql`${jobs.payload}->>'runId' = ${measure.id}`,
        ),
      )
      .limit(1);
    if (!job) throw new Error("The post-ship measurement has no queued job.");
    await step(
      "simulate_task_eval",
      (record) => simulateTaskEvalJob(project.id, record.payload, deps),
      job.id,
    );
    const [finished] = await db.select().from(taskEvalRuns).where(eq(taskEvalRuns.id, measure.id));
    if (finished?.status !== "completed" || finished.caseCount === 0)
      throw new Error("The demo needs recorded runs after the shipment date.");
  }
  const root = `http://localhost:3000/project/${encodeURIComponent(project.id)}/tasks`;
  const taskUrl = `${root}/${encodeURIComponent(task.id)}`;
  const shippedTask = measures[0]!.taskId;
  const urls = [
    root,
    taskUrl,
    `${taskUrl}/simulations`,
    `${taskUrl}/simulations/${encodeURIComponent(top.id)}`,
    `${root}/${encodeURIComponent(shippedTask)}?scoreView=chart`,
  ];
  const labels = [
    "Tasks",
    "Task",
    "Simulations",
    "Simulation",
    `Score marker (${version}, ${shipment.shippedAt.toISOString().slice(0, 10)})`,
  ];
  for (const [index, url] of urls.entries()) out(`${labels[index]}: ${url}`);
  out("Start the app with RATEL_EXPERIMENTAL_FEATURES=1 to open these pages.");
  if (options.noModels)
    out("Models are off. Drafts and simulations use local stand-ins. Live judging is skipped.");
  return {
    projectId: project.id,
    taskId: task.id,
    fixId: top.id,
    shipmentId: shipment.id,
    urls,
  };

  async function queued(kind: JobKind) {
    return db
      .select()
      .from(jobs)
      .where(and(eq(jobs.projectId, project.id), eq(jobs.kind, kind), eq(jobs.status, "queued")));
  }
  async function step(kind: JobKind, handler: JobHandler, jobId?: string, payload?: unknown) {
    const result = await runStep(db, project.id, kind, handler, { jobId, payload });
    if (result.status !== "done")
      throw new Error(`The ${kind} job failed. Read jobs.error for ${result.id}.`);
    return result;
  }
  async function simulate(fix: Fix) {
    if (fix.kind === "rewrite" || fix.kind === "tell-apart") {
      const pending = (await queued("draft_fix")).find(
        (job) => (job.payload as { fixId?: string } | null)?.fixId === fix.id,
      );
      await step(
        "draft_fix",
        (record) =>
          draftFixJob(project.id, record.payload, {
            ...deps,
            ...(options.noModels ? { model: demoDraftModel(fix) } : {}),
          }),
        pending?.id,
        { fixId: fix.id, requestedBy: ACTOR },
      );
    }
    const simulation = await runTaskSimulation(fix.id, {
      projectId: project.id,
      actor: ACTOR,
      deps,
    });
    if (simulation.status !== "queued" || !simulation.runs.length)
      throw new Error("The demo fix did not queue a simulation.");
    for (const run of simulation.runs) {
      const pending = (await queued("simulate_task_eval")).find(
        (job) => (job.payload as { runId?: string } | null)?.runId === run.id,
      );
      if (!pending) throw new Error("The task simulation has no queued job.");
      await step(
        "simulate_task_eval",
        (record) => simulateTaskEvalJob(project.id, record.payload, deps),
        pending.id,
      );
      const [finished] = await db.select().from(taskEvalRuns).where(eq(taskEvalRuns.id, run.id));
      if (finished?.status !== "completed")
        throw new Error("The demo simulation did not complete.");
    }
    out(`Simulated ${fix.id} on ${simulation.runs.length} tasks.`);
  }
}

async function projectFixes(
  projectId: string,
  project: { organizationId: string },
  db: Db,
  now: Date,
): Promise<Fix[]> {
  const organization = await getOrganizationById(project.organizationId);
  if (!organization) throw new Error("The project organization does not exist.");
  const model = await loadFixes({ projectId, organization, now, topics: false, deps: { db } });
  return [...model.open, ...model.applied];
}

/** Return a marked local draft through the same validation and budget path as a model draft. */
function demoDraftModel(fix: Fix): DraftModel {
  return {
    model: DEFAULT_DRAFT_MODEL,
    complete: async () => ({
      text: JSON.stringify({
        diagnosis: "Local demo draft. No model generated this text.",
        proposals: fix.subject.tools.map((tool) => ({
          entryId: tool.id,
          searchableDescription: `${tool.label}: ${fix.detail.source === "issue" ? fix.detail.changes.join(" ") : fix.why} Use this tool for ${fix.subject.tasks.map((task) => task.label).join(", ")}.`,
        })),
      }),
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  };
}

/** A project by id or slug (upstream's `resolveProject`). */
export async function resolveProject(
  db: Db,
  ref: string,
): Promise<{ id: string; slug: string; name: string; organizationId: string }> {
  const rows = (
    await db.execute<{ id: string; slug: string; name: string; organizationId: string }>(
      UUID.test(ref)
        ? sql`select id, slug, name, organization_id as "organizationId" from projects where id = ${ref}`
        : sql`select id, slug, name, organization_id as "organizationId" from projects where slug = ${ref} order by created_at limit 2`,
    )
  ).rows;
  if (rows.length === 0) throw new Error(`no project ${ref}`);
  if (rows.length > 1)
    throw new Error(`more than one project has the slug ${ref}: pass the project id`);
  return rows[0]!;
}

type JobRow = { id: string; status: string; result: unknown; error: string | null };

/**
 * One job through the runner as a row (upstream's `runStep`): the given queued job, else the
 * oldest queued one of the kind (only without a payload), else a new row with the payload.
 */
export async function runStep(
  db: Db,
  projectId: string,
  kind: JobKind,
  handler: JobHandler,
  options: { jobId?: string; payload?: unknown } = {},
): Promise<JobRow> {
  let claimedId: string | null = null;
  const store: JobStore = {
    claimNextQueued: async () => {
      if (claimedId !== null) return null;
      const job =
        (options.payload === undefined || options.jobId
          ? await claimQueued(db, projectId, kind, options.jobId)
          : null) ??
        (options.jobId ? null : await insertRunning(db, projectId, kind, options.payload ?? null));
      if (!job) throw new Error("The requested job is not queued in this project.");
      claimedId = job.id;
      return { id: job.id, projectId, kind, status: "running", payload: job.payload };
    },
    markDone: (id, result) => markJobDone(id, result, db),
    markError: async (id, error) => {
      await db.execute(
        sql`update jobs set status = 'error', error = ${error}, finished_at = now() where id = ${id}`,
      );
    },
  };
  await drainJobs(store, { [kind]: handler }, { projectId, max: 1 });
  const rows = (
    await db.execute<JobRow>(
      sql`select id, status, result, error from jobs where id = ${claimedId}`,
    )
  ).rows;
  return rows[0]!;
}

/** The oldest job of this kind queued for the project, now running; null when none is queued. */
async function claimQueued(
  db: Db,
  projectId: string,
  kind: string,
  jobId?: string,
): Promise<{ id: string; payload: unknown } | null> {
  const rows = (
    await db.execute<{ id: string; payload: unknown }>(sql`
      update jobs set status = 'running', started_at = now()
      where id = (select id from jobs where project_id = ${projectId} and kind = ${kind} and status = 'queued' and (${jobId ?? null}::uuid is null or id = ${jobId ?? null}::uuid)
                  order by created_at for update skip locked limit 1)
      returning id, payload`)
  ).rows;
  return rows[0] ?? null;
}

async function insertRunning(
  db: Db,
  projectId: string,
  kind: string,
  payload: unknown,
): Promise<{ id: string; payload: unknown }> {
  const rows = (
    await db.execute<{ id: string; payload: unknown }>(sql`
      insert into jobs (project_id, kind, status, payload, started_at)
      values (${projectId}, ${kind}, 'running', ${payload === null ? null : JSON.stringify(payload)}::jsonb, now())
      returning id, payload`)
  ).rows;
  return rows[0]!;
}
