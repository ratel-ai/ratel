import type { LogError } from "@/lib/platform/logger";
import { getLogger } from "@/lib/platform/logger";
import type { MatchQualityProposalRow } from "@/lib/synthesis/match-quality/schema";
import type { ProposalStatus } from "./types";

/**
 * Applying, dismissing and reverting a proposal.
 *
 * Every write goes through the SAME `setRuntimeCatalogOverride` the Catalogs
 * editor and the MCP `set_catalog_override` operation use. There is no second
 * write path, so an override set from here is indistinguishable from one typed by
 * hand, and the runtime pull that proves adoption covers both without knowing this
 * feature exists.
 *
 * The one thing this adds is REVERSIBILITY. Reverting by clearing the override
 * would be wrong whenever an operator had already written their own text: apply
 * would silently destroy it and revert would restore nothing. So the prior value
 * is read and stored before the write, and revert restores exactly that, including
 * restoring it to null.
 *
 * Every collaborator is injected, so this tests against a fake catalog with no
 * database and no ordering assumptions.
 */

const logger = getLogger("match-quality/apply");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);

export type ApplyOutcome =
  | { ok: true; status: ProposalStatus }
  /** The proposal had already left `pending`; someone else got there first. */
  | { ok: false; reason: "not_pending" }
  /** The catalog no longer has this entry, e.g. it was removed by a re-sync. */
  | { ok: false; reason: "entry_gone" }
  | { ok: false; reason: "not_found" };

export interface ApplyDeps {
  getProposal: (projectId: string, proposalId: string) => Promise<MatchQualityProposalRow | null>;
  /**
   * Replace one entry's override and report what it displaced, atomically.
   *
   * One call, not a read followed by a write: three surfaces write this column,
   * and a hand edit landing between a read and a write would be both lost and
   * mis-recorded, so Revert would restore a value that was never displaced.
   * Resolves undefined when the entry does not exist, which is distinct from a
   * stored null.
   */
  swapOverride: (
    projectId: string,
    entryId: string,
    searchableDescription: string | null,
  ) => Promise<{ previous: string | null } | undefined>;
  transitionProposal: (
    proposalId: string,
    from: string,
    to: string,
    extra?: Partial<{
      appliedAt: Date | null;
      appliedBy: string | null;
      revertedAt: Date | null;
      previousOverride: string | null;
    }>,
  ) => Promise<boolean>;
  now?: () => Date;
  logError?: LogError;
}

/** Apply one pending proposal, capturing what it displaced. */
export async function applyProposal(
  projectId: string,
  proposalId: string,
  actor: string,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  const now = deps.now?.() ?? new Date();
  const proposal = await deps.getProposal(projectId, proposalId);
  if (!proposal) return { ok: false, reason: "not_found" };
  if (proposal.status !== "pending") return { ok: false, reason: "not_pending" };

  // Claim the proposal BEFORE writing the catalog. If two operators click Apply
  // at once, the loser stops here having changed nothing; claiming afterwards
  // would let both write, and the second would record the first's text as the
  // value to revert to.
  const claimed = await deps.transitionProposal(proposalId, "pending", "applied", {
    appliedAt: now,
    appliedBy: actor,
  });
  if (!claimed) return { ok: false, reason: "not_pending" };

  let swapped: Awaited<ReturnType<ApplyDeps["swapOverride"]>>;
  try {
    swapped = await deps.swapOverride(projectId, proposal.entryId, proposal.proposedSearchable);
  } catch (error) {
    // Release the claim before rethrowing, so a transient write failure leaves an
    // actionable proposal rather than one that reads "applied" over a catalog
    // entry it never touched.
    await releaseClaim(proposalId, deps);
    throw error;
  }
  if (swapped === undefined) {
    // The entry was removed between drafting and applying. Put the proposal back
    // so the page does not claim an edit that never landed.
    await releaseClaim(proposalId, deps);
    return { ok: false, reason: "entry_gone" };
  }

  // Recorded AFTER the swap, because only the swap knows what was really there.
  await deps.transitionProposal(proposalId, "applied", "applied", {
    previousOverride: swapped.previous,
  });
  return { ok: true, status: "applied" };
}

/**
 * Undo the claim taken before a write that then did not happen.
 *
 * `previousOverride` is cleared along with it: it describes what an APPLIED
 * proposal displaced, and leaving a value on a proposal that is pending again
 * would have Revert restore text that was never replaced.
 */
async function releaseClaim(proposalId: string, deps: ApplyDeps): Promise<void> {
  await deps.transitionProposal(proposalId, "applied", "pending", {
    previousOverride: null,
    appliedAt: null,
    appliedBy: null,
  });
}

/**
 * Restore whatever the entry said before this proposal was applied.
 *
 * Claim-then-write, the same order as {@link applyProposal} and for the same two
 * reasons: it makes a double click a no-op rather than a double write, and it
 * means a failure can be compensated. Writing first and transitioning second
 * would leave the catalog reverted and the proposal still reading "applied" with
 * nothing to put it right.
 */
export async function revertProposal(
  projectId: string,
  proposalId: string,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  const now = deps.now?.() ?? new Date();
  const proposal = await deps.getProposal(projectId, proposalId);
  if (!proposal) return { ok: false, reason: "not_found" };
  if (proposal.status !== "applied") return { ok: false, reason: "not_pending" };

  const claimed = await deps.transitionProposal(proposalId, "applied", "reverted", {
    revertedAt: now,
  });
  if (!claimed) return { ok: false, reason: "not_pending" };

  let swapped: Awaited<ReturnType<ApplyDeps["swapOverride"]>>;
  try {
    swapped = await deps.swapOverride(projectId, proposal.entryId, proposal.previousOverride);
  } catch (error) {
    await deps.transitionProposal(proposalId, "reverted", "applied", { revertedAt: null });
    throw error;
  }
  if (swapped === undefined) {
    await deps.transitionProposal(proposalId, "reverted", "applied", { revertedAt: null });
    return { ok: false, reason: "entry_gone" };
  }
  return { ok: true, status: "reverted" };
}

export async function dismissProposal(
  projectId: string,
  proposalId: string,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  const proposal = await deps.getProposal(projectId, proposalId);
  if (!proposal) return { ok: false, reason: "not_found" };
  if (proposal.status !== "pending") return { ok: false, reason: "not_pending" };
  const moved = await deps.transitionProposal(proposalId, "pending", "dismissed");
  return moved ? { ok: true, status: "dismissed" } : { ok: false, reason: "not_pending" };
}

export interface BulkOutcome {
  applied: string[];
  failed: Array<{ proposalId: string; reason: string }>;
}

/**
 * Apply many proposals, reporting per item.
 *
 * Sequential and non-transactional on purpose. These are independent single-row
 * writes against different catalog entries, and a batch that rolled back on the
 * eleventh failure would discard ten good edits to punish one entry that had been
 * re-synced away. Reporting which ones did not land is more useful than an
 * all-or-nothing that usually means nothing.
 */
export async function applyProposals(
  projectId: string,
  proposalIds: readonly string[],
  actor: string,
  deps: ApplyDeps,
): Promise<BulkOutcome> {
  const logError = deps.logError ?? defaultLogError;
  const applied: string[] = [];
  const failed: BulkOutcome["failed"] = [];
  for (const proposalId of proposalIds) {
    try {
      const outcome = await applyProposal(projectId, proposalId, actor, deps);
      if (outcome.ok) applied.push(proposalId);
      else failed.push({ proposalId, reason: outcome.reason });
    } catch (error) {
      failed.push({ proposalId, reason: "error" });
      logError("match quality proposal apply failed", error, {
        project_id: projectId,
        proposal_id: proposalId,
      });
    }
  }
  return { applied, failed };
}
