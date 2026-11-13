import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";
import type { Organization } from "@/lib/platform/organizations";
import type { EvalDb } from "@/lib/views/eval-gate/runs";

/**
 * Whether the eval gate (RC-46 and its follow-up RC-61: holdout, outcome
 * checks, the judge and model replay) is on.
 *
 * Owned (ADR-0030): one switch for the deployment, `FF_EVAL_GATE` (or
 * `RATEL_EXPERIMENTAL_FEATURES` in the open-source edition), read from the
 * environment and off by default. Upstream decides it per organization and
 * person through its flag service; the functions keep upstream's names and
 * arguments so every call site stays identical, and ignore who is asking.
 */

type Env = Record<string, string | undefined>;

/** What a run's job says when the gate was turned off after it was queued. */
export const EVAL_GATE_OFF_ERROR = "The eval gate is off for this organization.";

export function evalGateEnabled(env: Env = process.env): boolean {
  return experimentalFeatureEnabled("FF_EVAL_GATE", env);
}

/** The signed-in person, in this organization (the project's, from its scope). */
export function evalGateEnabledFor(
  _organization: Organization,
  env: Env = process.env,
): Promise<boolean> {
  return Promise.resolve(evalGateEnabled(env));
}

/**
 * The gate for whoever asked, with no session: the MCP `run_eval` tool before
 * it simulates, and the background job before it runs a queued simulation.
 */
export function evalGateEnabledForActor(
  _projectId: string,
  _actor: string,
  _db?: EvalDb,
  env: Env = process.env,
): Promise<boolean> {
  return Promise.resolve(evalGateEnabled(env));
}

/** The background job's check, before it runs a queued simulation. */
export function evalGateEnabledForRun(
  run: { projectId: string; requestedBy: string | null },
  db?: EvalDb,
  env: Env = process.env,
): Promise<boolean> {
  return evalGateEnabledForActor(run.projectId, run.requestedBy ?? "system:eval-gate", db, env);
}
