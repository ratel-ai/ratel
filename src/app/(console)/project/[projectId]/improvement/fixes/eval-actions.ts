"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  reportServerException,
  type ServerEventName,
  trackServerEvent,
} from "@/lib/platform/telemetry";
import { parseExpected } from "@/lib/views/eval-gate/defaults";
import { evalGateEnabledFor } from "@/lib/views/eval-gate/gate";
import {
  addRunToSet,
  ensureEvalSet,
  loadFixContext,
  runSimulation,
  topUpEvalSet,
} from "@/lib/views/eval-gate/service";
import { getEvalSet, removeCase, updateCase } from "@/lib/views/eval-gate/store";
import { evalHref } from "@/lib/views/eval-gate/view";

/**
 * The eval gate's edits (RC-46), behind `FF_EVAL_GATE`: run a simulation,
 * add runs (by id, or more from history), change a run's expected outcome and
 * criteria, remove a run. Any member of the project may; membership is
 * re-resolved here and the client posts only ids and the edited fields.
 * Owned (ADR-0030): the project comes from the console scope.
 */

const logger = getLogger("fixes/eval-actions");

export type EvalActionResult = { ok: true; message?: string } | { ok: false; message: string };

const DENIED: EvalActionResult = { ok: false, message: "This eval can't be changed here." };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIX_ID = /^(rewrite|craft|issue|intent):[^\s]{1,200}$/;
const MAX_TEXT = 2_000;

interface Actor {
  externalId: string;
  projectId: string;
  orgId: string;
}

async function authorize(projectId: unknown, fixId: unknown): Promise<Actor | null> {
  if (
    typeof projectId !== "string" ||
    typeof fixId !== "string" ||
    !FIX_ID.test(fixId) ||
    !isDbConfigured()
  )
    return null;
  const scope = await findProjectScope(projectId);
  if (!scope) return null;
  if (!(await evalGateEnabledFor(scope.organization))) return null;
  return {
    externalId: scope.user.externalId,
    projectId: scope.project.id,
    orgId: scope.organization.id,
  };
}

async function track(
  actor: Actor,
  event: ServerEventName,
  fixId: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  await trackServerEvent(
    event,
    { externalId: actor.externalId, orgId: actor.orgId, projectId: actor.projectId },
    { object_action: event, fix_id: fixId, surface: "fix_eval", ...properties },
  );
}

function refresh(actor: Actor, fixId: string): void {
  revalidatePath(evalHref(actor.projectId, fixId));
  revalidatePath(`/project/${actor.projectId}/improvement/fixes`);
}

function failed(err: unknown, actor: Actor, operation: string, message: string): EvalActionResult {
  logger.error({ err, project_id: actor.projectId, operation }, "fix eval action failed");
  reportServerException(err, actor.externalId, { project_id: actor.projectId, operation });
  return { ok: false, message };
}

/** Simulate the fix on its eval set (made on first use), in the background. */
export async function runFixSimulationAction(
  projectId: string,
  fixId: string,
): Promise<EvalActionResult> {
  const actor = await authorize(projectId, fixId);
  if (!actor) return DENIED;
  try {
    const outcome = await runSimulation(fixId, {
      projectId: actor.projectId,
      trigger: "manual",
      background: true,
      actor: actor.externalId,
    });
    await track(actor, "fix_eval_simulation_requested", outcome.fixId, {
      run_id: outcome.runId,
      set_id: outcome.setId,
      runs: outcome.nCases,
    });
    refresh(actor, outcome.fixId);
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && err.name === "EvalGateError")
      return { ok: false, message: err.message };
    return failed(
      err,
      actor,
      "fix_eval_simulation_request",
      "Couldn't start the simulation. Try again in a moment.",
    );
  }
}

/** Make the eval set without simulating yet, so its runs can be edited first. */
export async function createEvalSetAction(
  projectId: string,
  fixId: string,
): Promise<EvalActionResult> {
  const actor = await authorize(projectId, fixId);
  if (!actor) return DENIED;
  try {
    const ctx = await loadFixContext(actor.projectId, fixId);
    if (!ctx) return { ok: false, message: "This fix isn't open any more." };
    const { set, created } = await ensureEvalSet(ctx, actor.externalId);
    if (created) await track(actor, "fix_eval_set_created", ctx.fix.id, { set_id: set.id });
    refresh(actor, ctx.fix.id);
    return { ok: true };
  } catch (err) {
    return failed(
      err,
      actor,
      "fix_eval_set_create",
      "Couldn't pick the runs. Try again in a moment.",
    );
  }
}

/** Fill the set up to its size with more of the project's runs. */
export async function addRunsFromHistoryAction(
  projectId: string,
  fixId: string,
): Promise<EvalActionResult> {
  const actor = await authorize(projectId, fixId);
  if (!actor) return DENIED;
  try {
    const ctx = await loadFixContext(actor.projectId, fixId);
    if (!ctx)
      return {
        ok: false,
        message: "This fix isn't open any more, so there are no runs to pick for it.",
      };
    const { set } = await ensureEvalSet(ctx, actor.externalId);
    const added = await topUpEvalSet(set, ctx.fix);
    if (added > 0)
      await track(actor, "fix_eval_case_added", ctx.fix.id, {
        set_id: set.id,
        added,
        how: "history",
      });
    refresh(actor, ctx.fix.id);
    return added > 0
      ? { ok: true, message: `Added ${added} ${added === 1 ? "run" : "runs"}.` }
      : { ok: true, message: "No more runs touch this fix." };
  } catch (err) {
    return failed(err, actor, "fix_eval_runs_add", "Couldn't add runs. Try again in a moment.");
  }
}

/** Add one run by its run id or trace id. */
export async function addEvalRunAction(
  projectId: string,
  fixId: string,
  runOrTraceId: string,
): Promise<EvalActionResult> {
  const actor = await authorize(projectId, fixId);
  if (!actor || typeof runOrTraceId !== "string") return DENIED;
  const value = runOrTraceId.trim();
  if (!value || value.length > 200) return { ok: false, message: "Paste a run id or a trace id." };
  try {
    const ctx = await loadFixContext(actor.projectId, fixId);
    const set = ctx
      ? (await ensureEvalSet(ctx, actor.externalId)).set
      : await getEvalSet(actor.projectId, fixId);
    if (!set) return { ok: false, message: "This fix isn't open any more." };
    const result = await addRunToSet(set, ctx?.fix ?? null, value);
    if (!result.ok) return { ok: false, message: "No run of this project has that id." };
    if (!result.added) return { ok: true, message: "That run is already in the eval." };
    await track(actor, "fix_eval_case_added", set.fixId, {
      set_id: set.id,
      added: 1,
      how: "manual",
    });
    refresh(actor, set.fixId);
    return { ok: true, message: "Run added." };
  } catch (err) {
    return failed(err, actor, "fix_eval_run_add", "Couldn't add the run. Try again in a moment.");
  }
}

export interface EvalCaseEdit {
  tool: string | null;
  maxToolCalls: number | null;
  maxSearches: number | null;
  maxFailedCalls: number | null;
  avoidTools: string[];
  /** RC-61 outcome checks; absent from older clients, which turns them off. */
  endsWell?: boolean | null;
  maxSelfCorrections?: number | null;
  maxCostUsd?: number | null;
  maxLatencyMs?: number | null;
  outcome: string;
  criteria: string;
}

/** Change one run's expected outcome and criteria. */
export async function updateEvalCaseAction(
  projectId: string,
  fixId: string,
  caseId: string,
  edit: EvalCaseEdit,
): Promise<EvalActionResult> {
  const actor = await authorize(projectId, fixId);
  if (
    !actor ||
    typeof caseId !== "string" ||
    !UUID.test(caseId) ||
    !edit ||
    typeof edit !== "object"
  )
    return DENIED;
  const outcome = typeof edit.outcome === "string" ? edit.outcome.trim() : "";
  const criteria = typeof edit.criteria === "string" ? edit.criteria.trim() : "";
  if (outcome.length > MAX_TEXT || criteria.length > MAX_TEXT)
    return {
      ok: false,
      message: `Keep the outcome and the criteria under ${MAX_TEXT} characters.`,
    };
  try {
    const set = await getEvalSet(actor.projectId, fixId);
    if (!set) return DENIED;
    const expected = parseExpected(edit);
    const updated = await updateCase(set.id, caseId, { expected, outcome, criteria });
    if (!updated) return { ok: false, message: "This run is no longer in the eval." };
    await track(actor, "fix_eval_case_updated", set.fixId, {
      set_id: set.id,
      case_id: caseId,
      checks: [
        expected.tool && "right_tool",
        expected.maxToolCalls !== null && "max_tool_calls",
        expected.maxSearches !== null && "max_searches",
        expected.maxFailedCalls !== null && "max_failed_calls",
        expected.avoidTools.length > 0 && "avoid_tools",
        expected.endsWell === true && "ends_well",
        expected.maxSelfCorrections != null && "max_self_corrections",
        expected.maxCostUsd != null && "max_cost",
        expected.maxLatencyMs != null && "max_latency",
        (outcome || criteria) && "criteria",
      ].filter(Boolean),
    });
    refresh(actor, set.fixId);
    return { ok: true };
  } catch (err) {
    return failed(
      err,
      actor,
      "fix_eval_case_update",
      "Couldn't save the expected outcome. Try again in a moment.",
    );
  }
}

/** Remove one run from the eval. */
export async function removeEvalCaseAction(
  projectId: string,
  fixId: string,
  caseId: string,
): Promise<EvalActionResult> {
  const actor = await authorize(projectId, fixId);
  if (!actor || typeof caseId !== "string" || !UUID.test(caseId)) return DENIED;
  try {
    const set = await getEvalSet(actor.projectId, fixId);
    if (!set) return DENIED;
    const removed = await removeCase(set.id, caseId);
    if (!removed) return { ok: false, message: "This run was already removed." };
    await track(actor, "fix_eval_case_removed", set.fixId, { set_id: set.id, case_id: caseId });
    refresh(actor, set.fixId);
    return { ok: true };
  } catch (err) {
    return failed(
      err,
      actor,
      "fix_eval_case_remove",
      "Couldn't remove the run. Try again in a moment.",
    );
  }
}
