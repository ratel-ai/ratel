"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { trackServerEvent } from "@/lib/platform/telemetry";
import {
  applyProposal,
  applyProposals,
  dismissProposal,
  revertProposal,
} from "@/lib/synthesis/match-quality/apply";
import { applyFailureMessage, liveApplyDeps } from "@/lib/synthesis/match-quality/apply-deps";
import {
  getProposal,
  lastCorpusChangeAt,
  listProposals,
} from "@/lib/synthesis/match-quality/queries";
import type { MatchQualityProposalRow } from "@/lib/synthesis/match-quality/schema";
import { startManualRun } from "@/lib/synthesis/match-quality/start-run";
import { proposalFailures, proposalImpact } from "@/lib/synthesis/match-quality/view";
import { windowSinceLastChange } from "@/lib/synthesis/match-quality/window";

/**
 * The write surface for match quality.
 *
 * Every action re-resolves the project scope, the flag and (for a run) the plan
 * budget server-side. Nothing the client posts is trusted beyond the ids, which
 * is the same discipline the calibration actions follow.
 */

export interface ActionResult {
  ok: boolean;
  message?: string;
}

/** Where a rewrite was acted on, for the event: Quality's page or Fixes. */
export type ProposalSurface = "quality" | "fixes";

/** The client says where it is; anything else is read as Quality, the original surface. */
function surfaceOf(raw: unknown): ProposalSurface {
  return raw === "fixes" ? "fixes" : "quality";
}

/** The pages that list rewrites, so a change shows on each after the action. */
function revalidateRewrites(projectId: string): void {
  revalidatePath(`/project/${projectId}/quality/descriptions`);
  revalidatePath(`/project/${projectId}/quality`);
  revalidatePath(`/project/${projectId}/improvement/fixes`);
}

/** Resolve and authorize the caller for one project, or explain why not. */
async function authorize(projectId: string) {
  if (!isDbConfigured()) return { ok: false as const, message: "No database connected." };
  const scope = await findProjectScope(projectId);
  if (!scope) return { ok: false as const, message: "Not found." };
  return { ok: true as const, session: { user: scope.user }, scope };
}

/** Queue a manual run over a chosen window. */
export async function runMatchQualityAction(
  projectId: string,
  windowDaysRaw: number,
): Promise<ActionResult> {
  const auth = await authorize(projectId);
  if (!auth.ok) return auth;
  const { scope, session } = auth;

  // The plan budget, the evidence source, the live-run slot and the job: one
  // path shared with the MCP `run_quality_analysis` tool.
  const outcome = await startManualRun({
    project: scope.project,
    organization: scope.organization,
    windowDaysRaw,
  });
  if (!outcome.ok) return { ok: false, message: outcome.message };
  if (outcome.status === "already_running") return { ok: true, message: outcome.message };

  await trackServerEvent(
    "match_quality_run_started",
    {
      externalId: session.user.externalId,
      orgId: scope.organization.id,
      projectId: scope.project.id,
    },
    {
      object_action: "match_quality_run_started",
      trigger: "manual",
      window_days: outcome.windowDays,
    },
  );
  revalidateRewrites(scope.project.id);
  return { ok: true };
}

/** The window a scheduled run would use next, for the surface to explain itself. */
export async function suggestedWindowDaysAction(projectId: string): Promise<number> {
  const auth = await authorize(projectId);
  if (!auth.ok) return 7;
  const changedAt = await lastCorpusChangeAt(auth.scope.project.id);
  return windowSinceLastChange(changedAt, new Date());
}

export async function applyProposalAction(
  projectId: string,
  proposalId: string,
  surface: ProposalSurface = "quality",
): Promise<ActionResult> {
  const auth = await authorize(projectId);
  if (!auth.ok) return auth;
  const { scope, session } = auth;

  const outcome = await applyProposal(
    scope.project.id,
    proposalId,
    session.user.externalId,
    liveApplyDeps(),
  );
  if (!outcome.ok) return { ok: false, message: applyFailureMessage(outcome.reason) };

  await trackServerEvent(
    "match_quality_proposal_applied",
    {
      externalId: session.user.externalId,
      orgId: scope.organization.id,
      projectId: scope.project.id,
    },
    {
      object_action: "match_quality_proposal_applied",
      proposal_id: proposalId,
      bulk: false,
      surface: surfaceOf(surface),
    },
  );
  revalidateRewrites(scope.project.id);
  return { ok: true };
}

export interface ApplyAllResult extends ActionResult {
  /** The proposals this call applied, so the caller can offer Undo for exactly those. */
  applied?: string[];
}

/** Apply every pending proposal, reporting per item rather than all-or-nothing. */
export async function applyAllProposalsAction(
  projectId: string,
  surface: ProposalSurface = "quality",
): Promise<ApplyAllResult> {
  const auth = await authorize(projectId);
  if (!auth.ok) return auth;
  const { scope, session } = auth;

  const pending = await listProposals(scope.project.id, { statuses: ["pending"] });
  if (pending.length === 0) return { ok: true, message: "Nothing left to apply.", applied: [] };

  const outcome = await applyProposals(
    scope.project.id,
    pending.map((row) => row.id),
    session.user.externalId,
    liveApplyDeps(),
  );

  await trackServerEvent(
    "match_quality_proposal_applied",
    {
      externalId: session.user.externalId,
      orgId: scope.organization.id,
      projectId: scope.project.id,
    },
    {
      object_action: "match_quality_proposal_applied",
      bulk: true,
      applied: outcome.applied.length,
      failed: outcome.failed.length,
      surface: surfaceOf(surface),
    },
  );
  revalidateRewrites(scope.project.id);
  if (outcome.failed.length === 0) {
    return { ok: true, message: `Applied ${outcome.applied.length}.`, applied: outcome.applied };
  }
  return {
    ok: true,
    message: `Applied ${outcome.applied.length}. ${outcome.failed.length} could not be applied and are still listed.`,
    applied: outcome.applied,
  };
}

/** One search a rewrite was drafted from: the ask, and the ids that reopen it. */
export interface RewriteSearch {
  query: string | null;
  /** The experiment selection (or search) it was seen on. */
  selectionId: string | null;
}

export interface RewriteSearchesResult extends ActionResult {
  searches?: RewriteSearch[];
  /** Missed searches beyond the ones listed. */
  more?: number;
}

/**
 * The searches a rewrite missed, read when its panel opens rather than shipped
 * with every row: they are people's asks. Scoped to the caller's project; reads
 * nothing else.
 */
export async function rewriteSearchesAction(
  projectId: string,
  proposalId: string,
): Promise<RewriteSearchesResult> {
  const auth = await authorize(projectId);
  if (!auth.ok) return auth;
  const id = auth.scope.project.id;
  const proposal = await loadOrFallback<MatchQualityProposalRow | null | undefined>({
    operation: "quality_v2_rewrite_searches",
    distinctId: `project:${id}`,
    fallback: undefined,
    load: () =>
      withStatementTimeout((db) => getProposal(id, proposalId, db), {
        operation: "quality_v2_rewrite_searches",
      }),
  });
  if (proposal === undefined)
    return { ok: false, message: "Couldn't load the searches. Try again in a moment." };
  if (proposal === null) return { ok: false, message: applyFailureMessage("not_found") };
  const failures = proposalFailures(proposal.evidence);
  const searches = failures.map((failure) => ({
    query: failure.query ?? null,
    selectionId: failure.selectionId ?? null,
  }));
  return { ok: true, searches, more: Math.max(0, proposalImpact(proposal).lost - searches.length) };
}

export async function dismissProposalAction(
  projectId: string,
  proposalId: string,
  surface: ProposalSurface = "quality",
): Promise<ActionResult> {
  const auth = await authorize(projectId);
  if (!auth.ok) return auth;
  const { scope, session } = auth;

  const outcome = await dismissProposal(scope.project.id, proposalId, liveApplyDeps());
  if (!outcome.ok) return { ok: false, message: applyFailureMessage(outcome.reason) };

  await trackServerEvent(
    "match_quality_proposal_dismissed",
    {
      externalId: session.user.externalId,
      orgId: scope.organization.id,
      projectId: scope.project.id,
    },
    {
      object_action: "match_quality_proposal_dismissed",
      proposal_id: proposalId,
      surface: surfaceOf(surface),
    },
  );
  revalidateRewrites(scope.project.id);
  return { ok: true };
}

export async function revertProposalAction(
  projectId: string,
  proposalId: string,
  surface: ProposalSurface = "quality",
): Promise<ActionResult> {
  const auth = await authorize(projectId);
  if (!auth.ok) return auth;
  const { scope, session } = auth;

  const outcome = await revertProposal(scope.project.id, proposalId, liveApplyDeps());
  if (!outcome.ok) return { ok: false, message: applyFailureMessage(outcome.reason) };

  await trackServerEvent(
    "match_quality_proposal_reverted",
    {
      externalId: session.user.externalId,
      orgId: scope.organization.id,
      projectId: scope.project.id,
    },
    {
      object_action: "match_quality_proposal_reverted",
      proposal_id: proposalId,
      surface: surfaceOf(surface),
    },
  );
  revalidateRewrites(scope.project.id);
  return { ok: true };
}
