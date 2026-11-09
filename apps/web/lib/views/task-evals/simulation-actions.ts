import { and, eq } from "drizzle-orm";
import { parseProjectUuid } from "@/lib/console/scope/cookie";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { hasEffect, parseChange } from "@/lib/views/eval-gate/change";
import { parseExpected } from "@/lib/views/eval-gate/defaults";
import { findRun } from "@/lib/views/eval-gate/runs";
import type { FixChange } from "@/lib/views/eval-gate/types";
import { fixDrafts } from "@/lib/views/fix-drafts/schema";
import type { CreateFixShipmentInput } from "@/lib/views/fixes/loop-queries";
import type { Fix } from "@/lib/views/fixes/types";
import { taskEvalCases, taskEvalSets } from "@/lib/views/task-evals/schema";
import { SCORER_VERSION } from "@/lib/views/task-scorers/engine";

type SimulationInput = { projectId: string; taskId: string; fixId: string } & (
  | { action: "run" }
  | { action: "mark-live"; version: string; notes: string | null }
  | { action: "draft"; change: FixChange }
  | { action: "add-test"; runId: string; expected: Record<string, unknown>; criteria: string }
  | { action: "edit-test"; caseId: string; expected: Record<string, unknown>; criteria: string }
);

export type TaskSimulationActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };
export interface TaskSimulationEditEvent {
  project_id: string;
  organization_id: string;
  task_id: string;
  fix_id: string;
  what: "draft" | "test" | "shipment";
  shipment_id?: string;
  actor: string;
}
export interface TaskSimulationActionDeps {
  db?: ReturnType<typeof getDb>;
  getSession(): Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope(
    projectId: string,
    userId: string,
  ): Promise<{ project: { id: string }; organization: { id: string } } | null>;
  enabled(projectId: string, actor: string): Promise<boolean>;
  loadFix(projectId: string, fixId: string): Promise<{ projectId: string; fix: Fix } | null>;
  run(
    fixId: string,
    options: { projectId: string; actor: string; trigger: "manual" },
  ): Promise<{ status: "drafting" | "queued" }>;
  ship?: (input: CreateFixShipmentInput) => Promise<{ id: string }>;
  observe(fields: TaskSimulationEditEvent): Promise<void>;
  now?: () => Date;
}

/** Check membership and the flag before reading or editing a simulation. */
export async function changeTaskSimulation(
  raw: unknown,
  deps: TaskSimulationActionDeps,
): Promise<TaskSimulationActionResult> {
  const input = parseInput(raw);
  if (!input) return { ok: false, error: "The simulation settings are invalid." };
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to edit simulations." };
  const scope = await deps.findProjectScope(input.projectId, session.user.id);
  if (!scope) return { ok: false, error: "You cannot edit this project's simulations." };
  const actor = session.user.externalId;
  if (!(await deps.enabled(scope.project.id, actor)))
    return { ok: false, error: "Simulations are off for this project." };
  const ctx = await deps.loadFix(scope.project.id, input.fixId);
  if (
    !ctx ||
    ctx.projectId !== scope.project.id ||
    !ctx.fix.subject.tasks.some((task) => task.id === input.taskId)
  ) {
    return { ok: false, error: "This fix does not belong to this task." };
  }
  if (input.action === "mark-live") {
    if (!deps.ship) return { ok: false, error: "Marking fixes as live is unavailable." };
    const shipment = await deps.ship({
      projectId: scope.project.id,
      fixId: ctx.fix.id,
      insightId: ctx.fix.issues[0]?.id ?? null,
      experimentId: null,
      version: input.version,
      notes: input.notes,
      shippedBy: actor,
    });
    await deps.observe({
      project_id: scope.project.id,
      organization_id: scope.organization.id,
      task_id: input.taskId,
      fix_id: ctx.fix.id,
      actor,
      what: "shipment",
      shipment_id: shipment.id,
    });
    return { ok: true, message: "Fix marked as live. Results appear after 20 runs or 7 days." };
  }
  if (input.action === "run") {
    const result = await deps.run(ctx.fix.id, {
      projectId: scope.project.id,
      actor,
      trigger: "manual",
    });
    return {
      ok: true,
      message:
        result.status === "drafting"
          ? "The draft is being prepared. Run again when it is ready."
          : "Simulation queued.",
    };
  }
  const db = deps.db ?? getDb();
  const fields: TaskSimulationEditEvent = {
    project_id: scope.project.id,
    organization_id: scope.organization.id,
    task_id: input.taskId,
    fix_id: ctx.fix.id,
    actor,
    what: input.action === "draft" ? "draft" : "test",
  };
  if (input.action === "draft") {
    await db.insert(fixDrafts).values({
      projectId: scope.project.id,
      fixId: ctx.fix.id,
      change: input.change,
      status: "ready",
      origin: "user",
      createdBy: actor,
      createdAt: deps.now?.() ?? new Date(),
    });
    await deps.observe(fields);
    return { ok: true, message: "Draft saved." };
  }
  if (input.action === "add-test") {
    const run = await findRun(scope.project.id, input.runId, db);
    if (!run) return { ok: false, error: "No run in this project has that ID." };
    const [closed] = await db
      .select({ id: traceTurns.id })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, scope.project.id),
          eq(traceTurns.id, run.turnId),
          eq(traceTurns.status, "closed"),
        ),
      )
      .limit(1);
    if (!closed) return { ok: false, error: "Only completed runs can become tests." };
    await db.transaction(async (tx) => {
      await tx
        .insert(taskEvalSets)
        .values({
          projectId: scope.project.id,
          taskId: input.taskId,
          scorerVersion: SCORER_VERSION,
        })
        .onConflictDoNothing();
      await tx
        .insert(taskEvalCases)
        .values({
          projectId: scope.project.id,
          taskId: input.taskId,
          fixId: ctx.fix.id,
          turnId: run.turnId,
          origin: "fix",
          expected: input.expected,
          criteria: input.criteria,
          selectionReason: "Added for this fix.",
        })
        .onConflictDoUpdate({
          target: [
            taskEvalCases.projectId,
            taskEvalCases.taskId,
            taskEvalCases.fixId,
            taskEvalCases.turnId,
          ],
          set: { expected: input.expected, criteria: input.criteria, excludedAt: null },
        });
    });
  } else {
    const [row] = await db
      .update(taskEvalCases)
      .set({ expected: input.expected, criteria: input.criteria })
      .where(
        and(
          eq(taskEvalCases.id, input.caseId),
          eq(taskEvalCases.projectId, scope.project.id),
          eq(taskEvalCases.taskId, input.taskId),
          eq(taskEvalCases.fixId, ctx.fix.id),
        ),
      )
      .returning({ id: taskEvalCases.id });
    if (!row) return { ok: false, error: "This test does not belong to this simulation." };
  }
  await deps.observe(fields);
  return { ok: true, message: input.action === "add-test" ? "Test added." : "Test saved." };
}

function parseInput(raw: unknown): SimulationInput | null {
  if (!record(raw)) return null;
  const projectId = typeof raw.projectId === "string" ? parseProjectUuid(raw.projectId) : null;
  const taskId = text(raw.taskId, 500);
  const fixId = text(raw.fixId, 500);
  if (!projectId || !taskId || !fixId) return null;
  const base = { projectId, taskId, fixId };
  if (raw.action === "mark-live") {
    const version = text(raw.version, 200);
    if (
      !version ||
      (raw.notes !== undefined &&
        raw.notes !== null &&
        (typeof raw.notes !== "string" || raw.notes.length > 10000))
    )
      return null;
    return {
      ...base,
      action: "mark-live",
      version,
      notes: typeof raw.notes === "string" ? raw.notes.trim() || null : null,
    };
  }
  if (raw.action === "run") return { ...base, action: "run" };
  if (
    raw.action === "draft" &&
    record(raw.change) &&
    JSON.stringify(raw.change).length <= 100_000
  ) {
    const change = parseChange(raw.change);
    if (!hasEffect(change) || change.unsupportedReason) return null;
    return { ...base, action: "draft", change };
  }
  if (
    (raw.action === "add-test" || raw.action === "edit-test") &&
    record(raw.expected) &&
    typeof raw.criteria === "string" &&
    raw.criteria.length <= 10_000
  ) {
    const parsed = parseExpected(raw.expected);
    const expected: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw.expected)) {
      if (
        !(key in parsed) ||
        JSON.stringify(parsed[key as keyof typeof parsed]) !== JSON.stringify(value)
      )
        return null;
      expected[key] = value;
    }
    if (raw.action === "add-test") {
      const runId = text(raw.runId, 200);
      return runId
        ? { ...base, action: "add-test", runId, expected, criteria: raw.criteria.trim() }
        : null;
    }
    const caseId = typeof raw.caseId === "string" ? parseProjectUuid(raw.caseId) : null;
    return caseId
      ? { ...base, action: "edit-test", caseId, expected, criteria: raw.criteria.trim() }
      : null;
  }
  return null;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null;
}
