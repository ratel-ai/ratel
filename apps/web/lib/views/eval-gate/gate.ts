import type { getDb } from "@/lib/platform/db/client";
import { experimentalFeatureEnabled, featureEnabled } from "@/lib/platform/experimental-features";
import type { Organization } from "@/lib/platform/organizations";

/** What the gate reads: a project's organization and the asking person's email. */
export type GateDb = Pick<ReturnType<typeof getDb>, "select">;

/**
 * Whether the eval gate (RC-46 and its follow-up RC-61: holdout, outcome
 * checks, the judge and model replay) is on.
 *
 * Owned (ADR-0030): the `FF_EVAL_GATE` switch, off by default. Without the
 * edition's flags port it is one switch for the deployment, read from the
 * environment (or `RATEL_EXPERIMENTAL_FEATURES` in the open-source edition);
 * with it, the edition decides it for the organization or the asking person
 * (`featureEnabled`). The functions keep upstream's names and arguments so
 * every call site stays identical. `evalGateEnabled` reads the environment
 * only: it has no one to ask about.
 */

type Env = Record<string, string | undefined>;

/** What a run's job says when the gate was turned off after it was queued. */
export const EVAL_GATE_OFF_ERROR = "The eval gate is off for this organization.";

export function evalGateEnabled(env: Env = process.env): boolean {
  return experimentalFeatureEnabled("FF_EVAL_GATE", env);
}

/** The signed-in person, in this organization (the project's, from its scope). */
export function evalGateEnabledFor(
  organization: Organization,
  env: Env = process.env,
): Promise<boolean> {
  return featureEnabled("FF_EVAL_GATE", { organizationId: organization.id }, { env });
}

/**
 * The gate for whoever asked, with no session: the MCP `run_eval` tool before
 * it simulates, and the background job before it runs a queued simulation.
 */
export function evalGateEnabledForActor(
  projectId: string,
  actor: string,
  _db?: GateDb,
  env: Env = process.env,
): Promise<boolean> {
  return featureEnabled("FF_EVAL_GATE", { projectId, actor }, { env });
}

/** The background job's check, before it runs a queued simulation. */
export function evalGateEnabledForRun(
  run: { projectId: string; requestedBy: string | null },
  db?: GateDb,
  env: Env = process.env,
): Promise<boolean> {
  return evalGateEnabledForActor(run.projectId, run.requestedBy ?? "system:eval-gate", db, env);
}
