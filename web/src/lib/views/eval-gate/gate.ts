import { getConfig } from "@/config";
import type { getDb } from "@/lib/platform/db/client";
import {
  experimentalFeatureEnabled,
  type FlagConfig,
  featureEnabled,
} from "@/lib/platform/experimental-features";
import type { Organization } from "@/lib/platform/organizations";

/** What the gate reads: a project's organization and the asking person's email. */
export type GateDb = Pick<ReturnType<typeof getDb>, "select">;

/**
 * Whether the eval gate (RC-46 and its follow-up RC-61: holdout, outcome
 * checks, the judge and model replay) is on.
 *
 * Owned (ADR-0004): the `evalGate` switch, off by default. Without the
 * edition's flags port it is one switch for the deployment, read from the
 * configuration (or `experimentalFeatures` in the open-source edition);
 * with it, the edition decides it for the organization or the asking person
 * (`featureEnabled`). The functions keep upstream's names and arguments so
 * every call site stays identical. `evalGateEnabled` reads the configuration
 * only: it has no one to ask about, so pages use the others.
 */

/** What a run's job says when the gate was turned off after it was queued. */
export const EVAL_GATE_OFF_ERROR = "The eval gate is off for this organization.";

export function evalGateEnabled(config: FlagConfig = getConfig()): boolean {
  return experimentalFeatureEnabled("evalGate", config);
}

/**
 * The gate for a project's eval pages, before the page resolves its organization: the layout's
 * check, so a switched-off gate answers a 404 before anything streams.
 */
export function evalGateEnabledForProject(
  projectId: string,
  config: FlagConfig = getConfig(),
): Promise<boolean> {
  return featureEnabled("evalGate", { projectId }, { config });
}

/** The signed-in person, in this organization (the project's, from its scope). */
export function evalGateEnabledFor(
  organization: Organization,
  config: FlagConfig = getConfig(),
): Promise<boolean> {
  return featureEnabled("evalGate", { organizationId: organization.id }, { config });
}

/**
 * The gate for whoever asked, with no session: the MCP `run_eval` tool before
 * it simulates, and the background job before it runs a queued simulation.
 */
export function evalGateEnabledForActor(
  projectId: string,
  actor: string,
  _db?: GateDb,
  config: FlagConfig = getConfig(),
): Promise<boolean> {
  return featureEnabled("evalGate", { projectId, actor }, { config });
}

/** The background job's check, before it runs a queued simulation. */
export function evalGateEnabledForRun(
  run: { projectId: string; requestedBy: string | null },
  db?: GateDb,
  config: FlagConfig = getConfig(),
): Promise<boolean> {
  return evalGateEnabledForActor(run.projectId, run.requestedBy ?? "system:eval-gate", db, config);
}
