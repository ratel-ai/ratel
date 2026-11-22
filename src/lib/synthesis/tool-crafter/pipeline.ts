import type { CorpusEntry } from "@/lib/readings/decisions/judge";
import type { StoredReliability } from "@/lib/readings/tool-explorer/reliability";
import type { ExplorerEdge, ExplorerNode, ExplorerSet } from "@/lib/readings/tool-explorer/types";
import type { ReplayCase } from "@/lib/synthesis/match-quality/replay";
import type { Candidate } from "@/lib/synthesis/match-quality/types";
import { backtestCraft, type CraftBacktest } from "@/lib/synthesis/tool-crafter/backtest";
import {
  type IntentFact,
  MAX_PER_KIND,
  MAX_PROPOSALS_PER_RUN,
  pickComposeCandidates,
  pickDeprecateCandidates,
  pickEnrichCandidates,
  pickFoldCandidates,
  pickGapCandidates,
  pickMergeCandidates,
  pickParallelCandidates,
  pickPreloadCandidates,
  pickRequireCandidates,
  pickRewriteCandidates,
  pickSplitByUseCandidates,
  pickTightenCandidates,
  type WorkflowFact,
} from "@/lib/synthesis/tool-crafter/candidates";
import {
  draftCompose,
  draftDeprecate,
  draftEnrich,
  draftFold,
  draftGap,
  draftMerge,
  draftParallel,
  draftPreload,
  draftRequire,
  draftRewrite,
  draftSplitByUse,
  draftTighten,
} from "@/lib/synthesis/tool-crafter/draft";
import {
  type IntentPatternFact,
  intentPair,
  pickIntentMergeCandidates,
} from "@/lib/synthesis/tool-crafter/intent-merge";
import type { NewProposal } from "@/lib/synthesis/tool-crafter/queries";
import { checkProposal } from "@/lib/synthesis/tool-crafter/schema-check";
import type {
  CraftEvidence,
  CraftedProposalBody,
  CraftKind,
  SourceTool,
} from "@/lib/synthesis/tool-crafter/types";

/**
 * One crafting pass, pure apart from the injected reads: nominate from the
 * Explorer's always-together pairs and match quality's deficits, draft each
 * by rules, check every draft, and hand back what should be stored. No model
 * is called: the proposals are suggestions for the customer to read, not
 * definitions written for them. Every nomination, kept or dropped, is
 * recorded for the run row.
 */

export interface ExplorerReading {
  runId: string | null;
  windowDays: number;
  /** The always-together pairs (merge candidates). */
  sets: ExplorerSet[];
  /** Every co-used pair, for the fold rule. */
  pairs: ExplorerSet[];
  edges: ExplorerEdge[];
  nodes: ExplorerNode[];
  /** Per-tool errors and retries, and per-pair error rates with and without a predecessor; absent on runs before it. */
  reliability?: StoredReliability;
  /** Agent health's mined workflows, for chains; empty without a signal run. */
  workflows?: WorkflowFact[];
  /** The asks, turn scope: shares, sure hops and first calls; absent on runs before the intent join stored them. */
  intents?: IntentFact[];
  /** Turns with at least one call in the window, for calls per turn. */
  turns?: number;
}

export interface CraftRunReads {
  loadExplorer: (projectId: string) => Promise<ExplorerReading>;
  /** The runtime's current tool definitions. */
  loadSources: (projectId: string) => Promise<SourceTool[]>;
  /** Match quality's ranked deficits, or [] when the project has no run. */
  loadDeficits: (projectId: string) => Promise<Candidate[]>;
  /** The labelled searches and corpus a backtest replays, or null when match quality has none. */
  loadBacktest?: (
    projectId: string,
  ) => Promise<{ corpus: CorpusEntry[]; cases: ReplayCase[] } | null>;
  /** Each live intent's stored tool pattern (the topics job's), for the intents' own merges; none when absent. */
  loadIntentPatterns?: (projectId: string) => Promise<IntentPatternFact[]>;
}

export interface CraftRunOptions {
  maxProposals?: number;
  maxPerKind?: number;
}

export interface CandidateRecord {
  kind: CraftKind;
  tools: string[];
  outcome: "proposed" | "dropped";
  reason?: string;
}

export interface CraftRunResult {
  explorerRunId: string | null;
  proposals: NewProposal[];
  candidates: CandidateRecord[];
  declinedReason: string | null;
}

export async function runToolCraft(
  projectId: string,
  reads: CraftRunReads,
  options: CraftRunOptions = {},
): Promise<CraftRunResult> {
  const maxProposals = options.maxProposals ?? MAX_PROPOSALS_PER_RUN;
  const maxPerKind = options.maxPerKind ?? MAX_PER_KIND;
  const perKind = new Map<CraftKind, number>();
  const [explorer, sources, deficits, intentPatterns] = await Promise.all([
    reads.loadExplorer(projectId),
    reads.loadSources(projectId),
    reads.loadDeficits(projectId),
    reads.loadIntentPatterns
      ? reads.loadIntentPatterns(projectId)
      : Promise.resolve([] as IntentPatternFact[]),
  ]);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const catalogIds = new Set(byId.keys());
  const candidates: CandidateRecord[] = [];
  const drafts: {
    body: CraftedProposalBody;
    sources: SourceTool[];
    evidence: NewProposal["evidence"];
  }[] = [];
  const taken = new Set<string>();
  const consider = (
    kind: CraftKind,
    tools: string[],
    sources: SourceTool[],
    body: CraftedProposalBody | null,
    evidence: CraftEvidence,
    dropReason: string,
  ) => {
    // One tool, one proposal: whatever a picker missed, a tool already proposed this run is not proposed again.
    const claimed = tools.filter((id) => taken.has(id));
    if (claimed.length > 0) {
      candidates.push({
        kind,
        tools,
        outcome: "dropped",
        reason: `already in a proposal this run: ${claimed.join(", ")}`,
      });
      return;
    }
    if (drafts.length >= maxProposals) {
      candidates.push({
        kind,
        tools,
        outcome: "dropped",
        reason: `more than ${maxProposals} proposals this run`,
      });
      return;
    }
    if ((perKind.get(kind) ?? 0) >= maxPerKind) {
      candidates.push({
        kind,
        tools,
        outcome: "dropped",
        reason: `more than ${maxPerKind} of this kind this run`,
      });
      return;
    }
    if (!body) {
      candidates.push({ kind, tools, outcome: "dropped", reason: dropReason });
      return;
    }
    const check = checkProposal(sources, body, catalogIds);
    if (!check.ok) {
      candidates.push({ kind, tools, outcome: "dropped", reason: check.problems.join("; ") });
      return;
    }
    drafts.push({ body, sources, evidence });
    perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
    candidates.push({ kind, tools, outcome: "proposed" });
    for (const id of tools) taken.add(id);
  };

  // A pair with a tool the runtime no longer declares is dropped before
  // nomination, so it cannot claim a tool a real pair needs.
  const known: ExplorerSet[] = [];
  for (const set of explorer.sets) {
    if (set.items.every((id) => byId.has(id))) known.push(set);
    else
      candidates.push({
        kind: "merge_tools",
        tools: [...set.items],
        outcome: "dropped",
        reason: "source tool not in the runtime catalog",
      });
  }
  // A chain first: it subsumes the pair merges inside it.
  for (const chain of pickComposeCandidates(explorer.workflows ?? [], taken, catalogIds, {
    max: maxProposals,
  })) {
    const tools = chain.order.map((id) => byId.get(id)!);
    consider(
      "compose_chain",
      chain.order,
      tools,
      draftCompose({ tools, evidence: chain.evidence, catalogIds }),
      { kind: "compose_chain", compose: chain.evidence },
      "",
    );
  }

  // A pair that runs both ways around is a parallel pair before it is a merge: a merge of it can only switch by `mode`, which saves no call.
  for (const pair of pickParallelCandidates(known, explorer.edges, taken, {
    max: maxProposals,
    nodes: explorer.nodes,
  })) {
    const a = byId.get(pair.a)!;
    const b = byId.get(pair.b)!;
    consider(
      "parallel_pair",
      [a.id, b.id],
      [a, b],
      draftParallel({ a, b, evidence: pair.evidence }),
      { kind: "parallel_pair", parallel: pair.evidence },
      "",
    );
  }

  for (const merge of pickMergeCandidates(
    known.filter((set) => !set.items.some((id) => taken.has(id))),
    explorer.edges,
    { max: maxProposals, nodes: explorer.nodes },
  )) {
    const a = byId.get(merge.a)!;
    const b = byId.get(merge.b)!;
    consider(
      "merge_tools",
      [a.id, b.id],
      [a, b],
      draftMerge({ a, b, evidence: merge.evidence, catalogIds }),
      { kind: "merge_tools", merge: merge.evidence },
      "",
    );
  }

  const knownPairs = explorer.pairs.filter((set) => set.items.every((id) => byId.has(id)));
  for (const fold of pickFoldCandidates(knownPairs, explorer.edges, taken, {
    max: maxProposals,
    nodes: explorer.nodes,
  })) {
    const a = byId.get(fold.a)!;
    const b = byId.get(fold.b)!;
    consider(
      "fold_prerequisite",
      [a.id, b.id],
      [a, b],
      draftFold({ a, b, evidence: fold.evidence, catalogIds }),
      { kind: "fold_prerequisite", fold: fold.evidence },
      "",
    );
  }

  // Per-ask rules: what one ask's units always do, read from the intent join.
  for (const en of pickEnrichCandidates(explorer.intents ?? [], sources, explorer.nodes, taken, {
    max: maxProposals,
  })) {
    const a = byId.get(en.a)!;
    const b = byId.get(en.b)!;
    consider(
      "enrich_response",
      [a.id, b.id],
      [a, b],
      draftEnrich({ a, b, evidence: en.evidence }),
      { kind: "enrich_response", enrich: en.evidence },
      "",
    );
  }

  for (const pre of pickPreloadCandidates(explorer.intents ?? [], sources, explorer.nodes, taken, {
    max: maxProposals,
  })) {
    const tool = byId.get(pre.toolId)!;
    consider(
      "preload_context",
      [tool.id],
      [tool],
      draftPreload({ tool, evidence: pre.evidence }),
      { kind: "preload_context", preload: pre.evidence },
      "",
    );
  }

  for (const su of pickSplitByUseCandidates(explorer.intents ?? [], sources, taken, {
    max: maxProposals,
  })) {
    const tool = byId.get(su.toolId)!;
    const followers = [...new Set(su.evidence.uses.map((u) => u.follower))].map(
      (id) => byId.get(id)!,
    );
    consider(
      "split_by_use",
      [tool.id, ...followers.map((f) => f.id)],
      [tool, ...followers],
      draftSplitByUse({ tool, evidence: su.evidence }),
      { kind: "split_by_use", splitByUse: su.evidence },
      "",
    );
  }

  const projectCallsPerUnit =
    explorer.turns && explorer.turns > 0
      ? explorer.nodes.filter((n) => n.subject === "tool").reduce((sum, n) => sum + n.calls, 0) /
        explorer.turns
      : null;
  for (const gap of pickGapCandidates(
    explorer.intents ?? [],
    projectCallsPerUnit,
    catalogIds,
    taken,
    { max: maxProposals },
  )) {
    const tools = gap.evidence.topTools
      .map((t) => byId.get(t.toolId))
      .filter((t): t is SourceTool => t !== undefined);
    if (tools.length === 0) {
      candidates.push({
        kind: "fill_gap",
        tools: gap.evidence.topTools.map((t) => t.toolId),
        outcome: "dropped",
        reason: "none of the ask's tools is in the runtime catalog",
      });
      continue;
    }
    consider(
      "fill_gap",
      tools.map((t) => t.id),
      tools,
      draftGap({ tools, evidence: gap.evidence }),
      { kind: "fill_gap", gap: gap.evidence },
      "",
    );
  }

  // Reliability before shape: a tool that fails gets its fix before a rewrite claims it.
  for (const req of pickRequireCandidates(
    explorer.reliability?.prerequisites ?? [],
    taken,
    { max: maxProposals },
    { tools: explorer.reliability?.tools ?? [], sources },
  )) {
    const a = byId.get(req.a);
    const b = byId.get(req.b);
    if (!a || !b) {
      candidates.push({
        kind: "require_prerequisite",
        tools: [req.a, req.b],
        outcome: "dropped",
        reason: "source tool not in the runtime catalog",
      });
      continue;
    }
    consider(
      "require_prerequisite",
      [a.id, b.id],
      [a, b],
      draftRequire({ a, b, evidence: req.evidence, catalogIds }),
      { kind: "require_prerequisite", require: req.evidence },
      "",
    );
  }

  for (const tight of pickTightenCandidates(explorer.reliability?.tools ?? [], sources, taken, {
    max: maxProposals,
  })) {
    const tool = byId.get(tight.toolId)!;
    consider(
      "tighten_schema",
      [tool.id],
      [tool],
      draftTighten({ tool, evidence: tight.evidence }),
      { kind: "tighten_schema", tighten: tight.evidence },
      "",
    );
  }

  for (const rewrite of pickRewriteCandidates(deficits, taken, { max: maxProposals })) {
    const tool = byId.get(rewrite.toolId);
    if (!tool) {
      candidates.push({
        kind: "rewrite_tool",
        tools: [rewrite.toolId],
        outcome: "dropped",
        reason: "tool not in the runtime catalog",
      });
      continue;
    }
    consider(
      "rewrite_tool",
      [tool.id],
      [tool],
      draftRewrite({ tool, evidence: rewrite.evidence }),
      { kind: "rewrite_tool", rewrite: rewrite.evidence },
      "the missed phrasings add no words the text lacks",
    );
  }

  for (const dead of pickDeprecateCandidates(sources, explorer.nodes, explorer.windowDays, taken, {
    max: maxProposals,
  })) {
    const tool = byId.get(dead.toolId)!;
    const replacement = dead.replacement ? (byId.get(dead.replacement) ?? null) : null;
    consider(
      "deprecate_tool",
      [tool.id],
      [tool],
      draftDeprecate({ tool, replacement, evidence: dead.evidence }),
      { kind: "deprecate_tool", deprecate: dead.evidence },
      "",
    );
  }

  // Last, one intent's own two-tool pattern: the same merge, with the intent as evidence. It takes
  // only tools no other rule claimed, so every other proposal reads as it did before it, and a pair
  // the project-wide rule merges is one proposal (and one dismissal: kind plus tools). A pair naming
  // a tool the runtime no longer declares is dropped before picking, so it claims no tool.
  const knownPair = (intent: IntentPatternFact) =>
    intentPair(intent)?.every((id) => byId.has(id)) ?? false;
  for (const lost of pickIntentMergeCandidates(
    intentPatterns.filter((intent) => intentPair(intent) !== null && !knownPair(intent)),
    taken,
  )) {
    candidates.push({
      kind: "merge_tools",
      tools: [lost.a, lost.b],
      outcome: "dropped",
      reason: "source tool not in the runtime catalog",
    });
  }
  for (const merge of pickIntentMergeCandidates(intentPatterns.filter(knownPair), taken, {
    max: maxProposals,
  })) {
    const a = byId.get(merge.a)!;
    const b = byId.get(merge.b)!;
    consider(
      "merge_tools",
      [a.id, b.id],
      [a, b],
      draftMerge({ a, b, evidence: merge.evidence, catalogIds }),
      { kind: "merge_tools", merge: merge.evidence },
      "",
    );
  }

  const proposals: NewProposal[] = [];
  const replay =
    reads.loadBacktest && drafts.length > 0 ? await reads.loadBacktest(projectId) : null;
  for (const draft of drafts.slice(0, maxProposals)) {
    const body = draft.body;
    const backtest: CraftBacktest | null =
      replay && replay.cases.length > 0 ? backtestCraft(replay.corpus, replay.cases, body) : null;
    proposals.push({ body, sources: draft.sources, evidence: draft.evidence, backtest });
  }

  const declinedReason =
    proposals.length > 0
      ? null
      : explorer.runId === null && deficits.length === 0
        ? "nothing to read yet: no Tool Craft run and no match quality run"
        : candidates.length === 0
          ? "no pair is always together, no intent's two tools always run together, no lookup only feeds one tool, no ask whose read always follows another tool, no ask that always opens with the same read, no tool used two ways, no ask without a path, no fixed chain, no order-free pair, no tool retried into success, no tool failing without a predecessor, no tool missed often enough, and nothing declared went unused"
          : "every candidate was dropped by the checks";
  return { explorerRunId: explorer.runId, proposals, candidates, declinedReason };
}
