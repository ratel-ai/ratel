import { changeOf, hasEffect } from "@/lib/views/eval-gate/change";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import type { FixChange } from "@/lib/views/eval-gate/types";
import type { Fix } from "@/lib/views/fixes/types";

/**
 * What later modules supply to the eval gate (the pattern of `fixSeams` in `views/fixes`): empty
 * here, filled by a module's registration when it lands. With a seam empty the gate works on what
 * it has; it is not a failure. No upstream counterpart: upstream imports those modules directly.
 */

export interface ResolvedChange {
  status: "ready" | "drafting" | "unsupported";
  change: FixChange;
}

export interface ResolveChangeOptions {
  db?: EvalDb;
  actor?: string;
  /** The environment the gate reads (upstream's flag deps); unset, `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface EvalGateSeams {
  /**
   * The change a fix makes, as a server-side read: fix drafts answer with the drafted change, or
   * queue a draft and say it is being prepared. Unset: the change the fix itself carries.
   */
  resolveChange?: (
    projectId: string,
    fix: Fix,
    options: ResolveChangeOptions,
  ) => Promise<ResolvedChange>;
  /**
   * What other model-calling modules of the same organization spent since a time, in USD (fix
   * drafts, the task loop, What-if): each adds a reader, so they share the one daily budget.
   */
  spendSince: Array<(projectId: string, since: Date, db: EvalDb) => Promise<number>>;
}

export const evalGateSeams: EvalGateSeams = { spendSince: [] };

/** Upstream's `resolveFixChange` (`lib/fix-drafts/resolve.ts`), through the seam. */
export async function resolveFixChange(
  projectId: string,
  fix: Fix,
  options: ResolveChangeOptions = {},
): Promise<ResolvedChange> {
  if (evalGateSeams.resolveChange) return evalGateSeams.resolveChange(projectId, fix, options);
  const change = changeOf(fix);
  return { status: hasEffect(change) ? "ready" : "unsupported", change };
}
