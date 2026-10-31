import { APP_NAME } from "@/lib/platform/app-config";
import { type DiffSpan, diffWords, isPureAddition } from "@/lib/synthesis/match-quality/diff";
import type { MatchQualityProposalRow } from "@/lib/synthesis/match-quality/schema";
import { toolEffectView } from "@/lib/synthesis/match-quality/tool-effect";
import {
  backtestView,
  groupProposals,
  proposalFailures,
  proposalImpact,
} from "@/lib/synthesis/match-quality/view";
import { type ChangeDirection, plural, pointChange } from "./model";

/**
 * Match quality's suggested rewrites as rows: the tool, how often it was
 * missed, what the rewrite changes, and what the replay of past searches says
 * it would do. The decision itself (Apply, Dismiss, Undo) stays with the
 * existing server actions; this only shapes what they act on.
 */

/** Example searches one suggestion lists before saying how many more there are. */
export const EXAMPLES_SHOWN = 5;

export interface SuggestionEffect {
  /** "+40 pts": how much more often the right tool is in the results. */
  delta: string;
  direction: ChangeDirection;
  /** "2 → 5 of 5 searches", or the catalog-wide pair for older replays. */
  detail: string;
}

export interface SuggestionExample {
  query: string | null;
  testHref: string | null;
}

export interface SuggestionRow {
  id: string;
  status: "pending" | "applied";
  toolId: string;
  toolName: string;
  /** Searches where this tool was the right answer and was not returned. */
  missed: number;
  change: "adds" | "rewrites";
  effect: SuggestionEffect | null;
  /** ISO time it was applied, for the Applied list. */
  appliedAt: string | null;
  spans: DiffSpan[];
  proposed: string;
  rationale: string;
  examples: SuggestionExample[];
  moreExamples: number;
}

export const CHANGE_LABEL: Record<SuggestionRow["change"], string> = {
  adds: "Adds wording",
  rewrites: "Rewrites",
};

export function missedLabel(missed: number): string {
  return missed === 0 ? "No recorded miss" : `Missed ${plural(missed, "search", "searches")}`;
}

/** Pending first, worst first; applied after. Dismissed, reverted and superseded rows are not shown. */
export function toSuggestionRows(
  proposals: readonly MatchQualityProposalRow[],
  testHref: (query: string, selectionId: string | null) => string | null,
): { pending: SuggestionRow[]; applied: SuggestionRow[] } {
  const groups = groupProposals(proposals);
  const row = (
    proposal: MatchQualityProposalRow,
    status: SuggestionRow["status"],
  ): SuggestionRow => {
    const spans = diffWords(proposal.currentSearchable, proposal.proposedSearchable);
    const failures = proposalFailures(proposal.evidence);
    const missed = proposalImpact(proposal).lost;
    const shown = failures.slice(0, EXAMPLES_SHOWN);
    return {
      id: proposal.id,
      status,
      toolId: proposal.entryId,
      toolName: proposal.entryName,
      missed,
      change: isPureAddition(spans) ? "adds" : "rewrites",
      effect: suggestionEffect(proposal),
      appliedAt: proposal.appliedAt ? proposal.appliedAt.toISOString() : null,
      spans,
      proposed: proposal.proposedSearchable,
      rationale: proposal.rationale,
      examples: shown.map((failure) => ({
        query: failure.query,
        testHref: failure.query ? testHref(failure.query, failure.selectionId ?? null) : null,
      })),
      // Counted in searches, not rows: one row is one distinct phrasing.
      moreExamples: Math.max(0, missed - shown.length),
    };
  };
  return {
    pending: groups.pending.map((proposal) => row(proposal, "pending")),
    applied: groups.applied.map((proposal) => row(proposal, "applied")),
  };
}

/**
 * What the replay says this rewrite does: the tool's own searches first (is it
 * in the results when it is the right answer), the whole catalog for replays
 * stored before per-tool counts existed.
 */
export function suggestionEffect(
  proposal: Pick<MatchQualityProposalRow, "backtest" | "entryId">,
): SuggestionEffect | null {
  const own = toolEffectView(proposal.backtest, proposal.entryId);
  if (own) {
    const change = pointChange(own.containedAfter / own.n, own.containedBefore / own.n);
    if (!change) return null;
    return {
      delta: change.text,
      direction: change.direction,
      detail: `${own.containedBefore} → ${own.containedAfter} of ${plural(own.n, "search", "searches")}`,
    };
  }
  const catalog = backtestView(proposal.backtest);
  const delta = containmentDelta(proposal.backtest);
  if (!catalog || delta === null) return null;
  const change = pointChange(delta, 0);
  if (!change) return null;
  return {
    delta: change.text,
    direction: change.direction,
    detail: `${catalog.before} → ${catalog.after} of all searches`,
  };
}

/* - Acting on a suggestion --------------------------------------------------- */

export type ActionOutcome = { ok: true } | { ok: false; message: string };

const ACTION_FAILED = "Something went wrong. Nothing changed; try again in a moment.";

/**
 * An existing server action's answer, with a throw (a network drop, a server
 * error) folded into a failure, so the caller always gets one to show and the
 * row it hid comes back.
 */
export async function settle(
  action: () => Promise<{ ok: boolean; message?: string }>,
): Promise<ActionOutcome> {
  try {
    const result = await action();
    return result.ok ? { ok: true } : { ok: false, message: result.message ?? ACTION_FAILED };
  } catch {
    return { ok: false, message: ACTION_FAILED };
  }
}

/**
 * What applying did, claimed only as far as the evidence goes: a runtime that
 * fetched this project's Cloud overrides recently gets the new wording; with
 * no such fetch, it is saved in Cloud and nothing more is promised.
 */
export function appliedToast(
  toolName: string,
  overridesAdopted: boolean | null,
): { title: string; description: string } {
  return overridesAdopted === true
    ? {
        title: "Rewrite applied",
        description: `${toolName} now matches searches with the new wording.`,
      }
    : {
        title: `Rewrite saved in ${APP_NAME}`,
        description: `${toolName} gets it once your agent attaches with ${APP_NAME} definitions.`,
      };
}

/** Undo and Revert both restore the old text and close the fix; say both. */
export function revertedToast(
  toolName: string,
  how: "undo" | "revert",
): { title: string; description: string } {
  return {
    title: how === "undo" ? "Rewrite undone" : "Rewrite reverted",
    description: `${toolName} is back to its previous description, and this fix is closed.`,
  };
}

/** Shown wherever a rewrite can be applied while nothing has fetched the overrides recently. */
export const NOT_REACHING_RUNTIME = `Nothing has fetched this project's ${APP_NAME} overrides recently, so an applied rewrite may not reach your agent yet.`;

/** The replay's change in how often the right tool is in the results, or null when it has none. */
export function containmentDelta(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const delta = (raw as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return null;
  const value = (delta as { containment?: unknown }).containment;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The whole set in one sentence, from the replay of the rewrites still
 * pending. It states the change, not the two percentages: the replay has its
 * own scale, and the change is the part that carries over.
 */
export function suggestionsSummary(raw: unknown, pending: number): string | null {
  if (pending === 0) return null;
  const view = backtestView(raw);
  const delta = containmentDelta(raw);
  if (!view || view.standing || delta === null) return null;
  const subject = pending === 1 ? "applying it" : `applying all ${pending}`;
  const points = Math.abs(Math.round(delta * 100));
  const amount = `${points} ${points === 1 ? "point" : "points"}`;
  if (view.direction === "flat") {
    return `Replayed on your past searches, ${subject} does not change how often the right tool is found.`;
  }
  const way = view.direction === "up" ? "more" : "less";
  const hedge = view.significant ? "" : ", within the margin of error";
  return `Replayed on your past searches, ${subject} finds the right tool ${amount} ${way} often${hedge}.`;
}
