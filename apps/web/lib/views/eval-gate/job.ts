import { createBackgroundObservability } from "@/lib/jobs/observability";
import { EVAL_GATE_OFF_ERROR, evalGateEnabledForRun } from "./gate";
import { type EvalGateDeps, executeEvalRun } from "./service";
import { failEvalRun, getEvalRun, parseStatus, parseTally, parseVerdict } from "./store";

/**
 * The `simulate_fix_eval` job: one queued simulation, run off the request
 * (the eval page's "Run simulation"). Coalescing is the table's: one live run
 * per set, so a second click finds the queued one.
 *
 * The job has no session, so it decides `cloud-eval-gate` again for whoever
 * queued the run, in the project's organization (`evalGateEnabledForActor`: a
 * person by their Clerk id and email, an API key as `project:<id>` with the
 * organization's properties): a run queued before the gate was turned off
 * there is failed, and nothing is simulated or called.
 */

export interface SimulateFixEvalPayload {
  runId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSimulatePayload(payload: unknown): SimulateFixEvalPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const runId = (payload as Record<string, unknown>).runId;
  return typeof runId === "string" && UUID.test(runId) ? { runId } : null;
}

export interface SimulateFixEvalJobDeps {
  /** Whether the gate is on for the run's requester in the project's organization. */
  gateEnabled?: (run: { projectId: string; requestedBy: string | null }) => Promise<boolean>;
  eval?: Partial<EvalGateDeps>;
}

export async function simulateFixEvalJob(
  projectId: string,
  payload: unknown,
  deps: SimulateFixEvalJobDeps = {},
): Promise<unknown> {
  const parsed = parseSimulatePayload(payload);
  if (!parsed) return { simulated: false, reason: "invalid_payload" };
  const db = deps.eval?.db;
  const queued = await getEvalRun(parsed.runId, db);
  if (!queued || queued.projectId !== projectId)
    return { simulated: false, reason: "run_not_found" };
  const gateEnabled = deps.gateEnabled ?? ((run) => evalGateEnabledForRun(run, db));
  if (queued.status === "queued" && !(await gateEnabled(queued))) {
    await failEvalRun(queued.id, EVAL_GATE_OFF_ERROR, db);
    return { simulated: false, reason: "gate_off" };
  }
  const observability = createBackgroundObservability();
  const run = await executeEvalRun(parsed.runId, deps.eval);
  if (!run) return { simulated: false, reason: "run_not_found" };
  const status = parseStatus(run.status);
  const properties = {
    object_action:
      status === "completed" ? "fix_eval_simulation_completed" : "fix_eval_simulation_failed",
    run_id: run.id,
    set_id: run.setId,
    runs: run.nCases,
    simulated: run.nSimulated,
    verdict: parseVerdict(run.verdict),
    pass_rate_before: parseTally(run.before)?.passRate ?? null,
    pass_rate_after: parseTally(run.after)?.passRate ?? null,
  };
  await observability.trackSystemEvent(
    status === "completed" ? "fix_eval_simulation_completed" : "fix_eval_simulation_failed",
    "system:eval-gate",
    {
      ...properties,
      project_id: projectId,
    },
  );
  return {
    simulated: status === "completed",
    status,
    verdict: properties.verdict,
    runs: run.nCases,
  };
}
