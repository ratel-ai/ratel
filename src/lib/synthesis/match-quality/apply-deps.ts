import type { ApplyDeps } from "./apply";
import { getProposal, swapRuntimeOverride, transitionProposal } from "./queries";

/**
 * The real collaborators behind apply, dismiss and revert, and the words a
 * refusal is explained in. Shared by the console's actions and the MCP
 * `review_description_rewrite` tool, so a rewrite acted on from either moves
 * through the same writes and reads the same when it cannot.
 */
export function liveApplyDeps(): ApplyDeps {
  return {
    getProposal,
    swapOverride: swapRuntimeOverride,
    transitionProposal: (proposalId, from, to, extra) =>
      transitionProposal(proposalId, from, to, extra),
  };
}

export function applyFailureMessage(reason: string): string {
  if (reason === "entry_gone") {
    return "That tool is no longer in the catalog, so the edit could not be written.";
  }
  if (reason === "not_pending") {
    return "That proposal has already been acted on.";
  }
  return "That proposal no longer exists.";
}
