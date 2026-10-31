import { type DiffSpan, diffWords, isPureAddition } from "@/lib/synthesis/match-quality/diff";
import type {
  MatchQualityProposalRow,
  MatchQualityRunRow,
} from "@/lib/synthesis/match-quality/schema";
import { toolEffectView } from "@/lib/synthesis/match-quality/tool-effect";
import {
  backtestView,
  groupProposals,
  proposalImpact,
  type RunPhase,
  runStatus,
  sourceLabel,
} from "@/lib/synthesis/match-quality/view";
import type { ToolTally } from "./misses";
import { type ChangeDirection, pointChange, rewritePeek } from "./model";
import { containmentDelta } from "./suggestions";

/**
 * Quality › Descriptions as plain data: each searchable-description rewrite
 * with its before and after and what a replay of past searches says it does,
 * the whole pending set's effect, and, for a tool with no rewrite, its
 * description as it stands. Apply, Dismiss and Revert stay with Match quality's
 * server actions; this only shapes what they act on.
 */

/** What a replay of past searches says one rewrite does for its own tool. */
export interface RewriteEffect {
  /** "+40 pts": how much more often the tool is found where it was the right one. */
  delta: string;
  direction: ChangeDirection;
  /** The tool's own replayed searches, found before and after; null on replays stored before per-tool counts. */
  tool: { n: number; before: number; after: number } | null;
}

export interface RewriteRow {
  /** The proposal's id. */
  id: string;
  /** Its `?peek=` value. */
  peek: string;
  status: "pending" | "applied";
  toolId: string;
  toolName: string;
  /** Searches where this tool was the right one and was not returned. */
  missed: number;
  change: "adds" | "rewrites";
  effect: RewriteEffect | null;
  /** ISO time it was drafted, and applied. */
  createdAt: string;
  appliedAt: string | null;
  /** The searchable description it replaces, and the new one. */
  before: string;
  after: string;
  spans: DiffSpan[];
  /** One sentence: what changed. */
  rationale: string;
}

/** The replay's effect for one rewrite: its tool's own searches first, the whole catalog for older replays. */
export function rewriteEffect(
  proposal: Pick<MatchQualityProposalRow, "backtest" | "entryId">,
): RewriteEffect | null {
  const own = toolEffectView(proposal.backtest, proposal.entryId);
  if (own) {
    const change = pointChange(own.containedAfter / own.n, own.containedBefore / own.n);
    if (!change) return null;
    return {
      delta: change.text,
      direction: change.direction,
      tool: { n: own.n, before: own.containedBefore, after: own.containedAfter },
    };
  }
  const delta = containmentDelta(proposal.backtest);
  const change = delta === null ? null : pointChange(delta, 0);
  return change ? { delta: change.text, direction: change.direction, tool: null } : null;
}

function rewriteRow(proposal: MatchQualityProposalRow, status: RewriteRow["status"]): RewriteRow {
  const spans = diffWords(proposal.currentSearchable, proposal.proposedSearchable);
  return {
    id: proposal.id,
    peek: rewritePeek(proposal.id),
    status,
    toolId: proposal.entryId,
    toolName: proposal.entryName,
    missed: proposalImpact(proposal).lost,
    change: isPureAddition(spans) ? "adds" : "rewrites",
    effect: rewriteEffect(proposal),
    createdAt: proposal.createdAt.toISOString(),
    appliedAt: proposal.appliedAt ? proposal.appliedAt.toISOString() : null,
    before: proposal.currentSearchable,
    after: proposal.proposedSearchable,
    spans,
    rationale: proposal.rationale,
  };
}

/** To review (the most missed first) and applied (newest first). Dismissed, reverted and superseded rewrites are closed. */
export function rewriteRows(proposals: readonly MatchQualityProposalRow[]): {
  pending: RewriteRow[];
  applied: RewriteRow[];
} {
  const groups = groupProposals(proposals);
  return {
    pending: groups.pending.map((proposal) => rewriteRow(proposal, "pending")),
    applied: groups.applied
      .map((proposal) => rewriteRow(proposal, "applied"))
      .sort((left, right) => (right.appliedAt ?? "").localeCompare(left.appliedAt ?? "")),
  };
}

/** Every pending rewrite applied at once, replayed on past searches against today's catalog. */
export interface Projection {
  pending: number;
  /** "+14 pts". */
  delta: string;
  direction: ChangeDirection;
  /** False when the replay cannot rule out no change at all. */
  significant: boolean;
  /** Past searches replayed. */
  replayed: number;
}

/** The replay of the rewrites still pending, or null when there is none or it moved nothing. */
export function projectionOf(raw: unknown, pending: number): Projection | null {
  if (pending === 0) return null;
  const view = backtestView(raw);
  const delta = containmentDelta(raw);
  if (!view || view.standing || delta === null) return null;
  const change = pointChange(delta, 0);
  if (!change) return null;
  const replayed = typeof (raw as { n?: unknown }).n === "number" ? (raw as { n: number }).n : 0;
  return {
    pending,
    delta: change.text,
    direction: change.direction,
    significant: view.significant,
    replayed,
  };
}

/** Where the last analysis stands, for the empty states. */
export interface RunView {
  phase: RunPhase;
  declinedReason: string | null;
}

export function runView(
  run: Pick<MatchQualityRunRow, "status" | "declinedReason"> | null,
): RunView | null {
  return run ? { phase: runStatus(run).phase, declinedReason: run.declinedReason } : null;
}

/** A tool `?tool=` asked for that has no rewrite: its description as it stands and how it does today. */
export interface ToolCard {
  id: string;
  name: string;
  /** Null when the catalog has no such tool. */
  description: string | null;
  /** Where that text comes from, in the catalog's words. */
  source: string | null;
  /** Its searches in the window; null when it was never the right tool. */
  tally: ToolTally | null;
  /** Catalog's editor for this tool. */
  catalogHref: string;
}

export function toolCard(
  entry: { entryId: string; name: string; searchable: string; source: string },
  tally: ToolTally | undefined,
  catalogHref: string,
): ToolCard {
  return {
    id: entry.entryId,
    name: entry.name,
    description: entry.searchable,
    source: sourceLabel(entry.source),
    tally: tally && tally.searches > 0 ? tally : null,
    catalogHref,
  };
}

/** Catalog's Tools page with this tool open, where its searchable description is edited. */
export function catalogEditHref(projectId: string, toolName: string): string {
  return `/project/${encodeURIComponent(projectId)}/catalogs/tools?highlight=${encodeURIComponent(toolName)}`;
}

/**
 * The row `?tool=` asks for: its pending rewrite before an applied one, the
 * newest of either. Null when the tool has no open rewrite.
 */
export function rewriteForTool<T extends Pick<RewriteRow, "toolId" | "status">>(
  rows: readonly T[],
  toolId: string | null,
): T | null {
  if (!toolId) return null;
  return (
    rows.find((row) => row.toolId === toolId && row.status === "pending") ??
    rows.find((row) => row.toolId === toolId) ??
    null
  );
}

/** What the address opens: a rewrite by its `?peek=`, else the one `?tool=` names, else that tool's card. */
export type OpenTarget<T> = { kind: "rewrite"; row: T } | { kind: "tool"; toolId: string };

export function openTarget<T extends Pick<RewriteRow, "peek" | "toolId" | "status">>(
  rows: readonly T[],
  peek: string | null,
  tool: string | null,
): OpenTarget<T> | null {
  const byPeek = peek ? rows.find((row) => row.peek === peek) : undefined;
  if (byPeek) return { kind: "rewrite", row: byPeek };
  if (!tool) return null;
  const forTool = rewriteForTool(rows, tool);
  return forTool ? { kind: "rewrite", row: forTool } : { kind: "tool", toolId: tool };
}

/**
 * The query string after opening a rewrite (or closing, with null). `?tool=` is
 * an entrance, not a state: once a panel opens or closes the rewrite's own
 * `?peek=` is what the address keeps.
 */
export function descriptionsSearch(search: string, peek: string | null): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  params.delete("tool");
  if (peek) params.set("peek", peek);
  else params.delete("peek");
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Revert and Undo both put the old text back; say so. */
export function revertedToast(
  toolName: string,
  how: "undo" | "revert",
): { title: string; description: string } {
  return {
    title: how === "undo" ? "Rewrite undone" : "Rewrite reverted",
    description: `${toolName} is back to its previous searchable description.`,
  };
}

/** "3 rewrites", "1 rewrite". */
export function rewritesCount(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "rewrite" : "rewrites"}`;
}
