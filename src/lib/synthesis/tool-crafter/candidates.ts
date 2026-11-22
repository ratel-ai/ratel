import type {
  PrerequisiteReliability,
  ToolReliability,
} from "@/lib/readings/tool-explorer/reliability";
import { ALWAYS_TOGETHER_LOW, SURE_HOP_P } from "@/lib/readings/tool-explorer/thresholds";
import type {
  ExplorerEdge,
  ExplorerNode,
  ExplorerSet,
  StoredIntentEdge,
  StoredIntentFirst,
} from "@/lib/readings/tool-explorer/types";
import { DEFAULT_FLOORS } from "@/lib/readings/trace-signals/signals/catalog";
import { wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import type { Candidate } from "@/lib/synthesis/match-quality/types";
import { nameParts } from "@/lib/synthesis/tool-crafter/draft";
import type {
  ComposeEvidence,
  DeprecateEvidence,
  EnrichEvidence,
  FoldEvidence,
  GapEvidence,
  MergeEvidence,
  PairTiming,
  ParallelEvidence,
  PreloadEvidence,
  RequireEvidence,
  RewriteEvidence,
  SourceTool,
  SplitByUseEvidence,
  TightenEvidence,
} from "@/lib/synthesis/tool-crafter/types";

/**
 * Deterministic nomination: which tools a run proposes to craft, and the
 * evidence each draft is built from. Rules only; the thresholds are named
 * here so the README can quote them and a reader finds them in one place.
 *
 * - A merge needs a pair the agent (within the bound) never runs apart: the
 *   Explorer's `listMergeCandidates` already applies the Jaccard floor, and
 *   here the pair also needs enough support to be more than a habit of one
 *   session.
 * - A rewrite needs a tool that match quality saw missed often enough that
 *   the phrasings are worth adding, and not already proposed by the Explorer
 *   as half of a merge (one tool, one proposal).
 */

export const MERGE_MIN_SUPPORT = 10;
export const MERGE_MIN_JACCARD_LOW = ALWAYS_TOGETHER_LOW;
export const REWRITE_MIN_MISSES = 3;
export const FOLD_MIN_SUPPORT = 10;
/** The lookup goes on to the main tool at least this often... */
export const FOLD_MIN_P_AB = 0.95;
/** ...while the main tool runs without the lookup at least this often... */
export const FOLD_MAX_P_BA = 0.6;
/** ...and the lookup is the call right before the main tool at least this often: a lookup feeds the next call, not one three steps on. */
export const FOLD_MIN_NEXT_P = 0.5;
export const DEPRECATE_MIN_WINDOW_DAYS = 30;
export const MAX_PROPOSALS_PER_RUN = 16;
/** Proposals of one kind per run: the kinds that run first cannot fill the run before a retirement or rewrite is reached. */
export const MAX_PER_KIND = 3;

export interface MergeCandidate {
  a: string;
  b: string;
  evidence: MergeEvidence;
}

/** One scope's edges: the crafter reads both scopes in one list, and a pair is judged only on the scope it was counted in. */
function inScope(edges: readonly ExplorerEdge[], scope: ExplorerSet["scope"]): ExplorerEdge[] {
  return edges.filter((e) => e.scope === scope);
}

/** The `next` edges of the pair's scope, both directions, to tell a sequence from a swap. */
function direction(
  a: string,
  b: string,
  edges: readonly ExplorerEdge[],
): Pick<MergeEvidence, "nextP" | "orderAb" | "orderBa"> {
  const ab = edges.find((e) => e.kind === "next" && e.a === a && e.b === b);
  const ba = edges.find((e) => e.kind === "next" && e.a === b && e.b === a);
  const before = edges.find((e) => e.kind === "before" && e.a === a && e.b === b);
  const reverse = edges.find((e) => e.kind === "before" && e.a === b && e.b === a);
  return {
    nextP: ab ? ab.p : ba ? 0 : null,
    orderAb: before?.n ?? ab?.n ?? 0,
    orderBa: reverse?.n ?? ba?.n ?? 0,
  };
}

/** The pair's time facts from the Explorer's nodes and `next` edges, or undefined when nothing was timed. */
export function pairTiming(
  a: string,
  b: string,
  edges: readonly ExplorerEdge[],
  nodes: readonly ExplorerNode[],
): PairTiming | undefined {
  const na = nodes.find((n) => n.id === a);
  const nb = nodes.find((n) => n.id === b);
  const ab = edges.find((e) => e.kind === "next" && e.a === a && e.b === b)?.timing;
  const ba = edges.find((e) => e.kind === "next" && e.a === b && e.b === a)?.timing;
  if (!na && !nb && !ab && !ba) return undefined;
  const pairs = (ab?.pairs ?? 0) + (ba?.pairs ?? 0);
  const medians = [ab, ba].filter(
    (t): t is NonNullable<typeof t> => !!t && t.betweenMsMedian !== null,
  );
  // Two medians weighted by their pair counts: close enough for a sentence, and honest about which direction dominated.
  const handoffMedian =
    medians.length === 0
      ? null
      : Math.round(
          medians.reduce((sum, t) => sum + (t.betweenMsMedian ?? 0) * t.pairs, 0) /
            Math.max(
              1,
              medians.reduce((sum, t) => sum + t.pairs, 0),
            ),
        );
  return {
    aCalls: na?.calls ?? 0,
    bCalls: nb?.calls ?? 0,
    aMedianMs: na?.medianMs ?? null,
    bMedianMs: nb?.medianMs ?? null,
    aTotalMs: na?.totalMs ?? 0,
    bTotalMs: nb?.totalMs ?? 0,
    handoffPairs: pairs,
    handoffMsTotal: (ab?.betweenMsTotal ?? 0) + (ba?.betweenMsTotal ?? 0),
    handoffMsMedian: handoffMedian,
    searchesBetween: (ab?.searchesBetween ?? 0) + (ba?.searchesBetween ?? 0),
  };
}

/** Which of the pair goes first in the draft: the one that usually runs first. */
function orient(set: ExplorerSet, edges: readonly ExplorerEdge[]): [string, string] {
  const [x, y] = set.items as [string, string];
  const xy = direction(x, y, inScope(edges, set.scope));
  return xy.orderAb >= xy.orderBa ? [x, y] : [y, x];
}

/**
 * Merge candidates from the Explorer's always-together pairs, oriented so `a`
 * is the tool that usually runs first. `edges` are the transitions (both
 * kinds); each pair reads its own scope's.
 */
export function pickMergeCandidates(
  sets: readonly ExplorerSet[],
  edges: readonly ExplorerEdge[],
  opts: {
    minSupport?: number;
    minJaccardLow?: number;
    max?: number;
    nodes?: readonly ExplorerNode[];
  } = {},
): MergeCandidate[] {
  const minSupport = opts.minSupport ?? MERGE_MIN_SUPPORT;
  const minLow = opts.minJaccardLow ?? MERGE_MIN_JACCARD_LOW;
  const out: MergeCandidate[] = [];
  const used = new Set<string>();
  for (const set of [...sets].sort(
    (x, y) => (y.jaccardLow ?? 0) - (x.jaccardLow ?? 0) || y.support - x.support,
  )) {
    if (set.subject !== "tool" || set.size !== 2) continue;
    if (set.support < minSupport || (set.jaccardLow ?? 0) < minLow) continue;
    if (set.items.some((id) => used.has(id) || id.startsWith("skill:"))) continue;
    const [a, b] = orient(set, edges);
    const scoped = inScope(edges, set.scope);
    const unitsA =
      set.pAb && set.pAb > 0
        ? Math.round(set.support / (a === set.items[0] ? set.pAb : set.pBa!))
        : set.support;
    const unitsB =
      set.pBa && set.pBa > 0
        ? Math.round(set.support / (a === set.items[0] ? set.pBa : set.pAb!))
        : set.support;
    out.push({
      a,
      b,
      evidence: {
        scope: set.scope,
        support: set.support,
        unitsA,
        unitsB,
        jaccard: set.jaccard ?? 0,
        jaccardLow: set.jaccardLow ?? 0,
        pAb: set.support / Math.max(1, unitsA),
        pBa: set.support / Math.max(1, unitsB),
        ...direction(a, b, scoped),
        exampleSessions: [...set.exampleSessions],
        timing: pairTiming(a, b, scoped, opts.nodes ?? []),
      },
    });
    used.add(a);
    used.add(b);
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) break;
  }
  return out;
}

export interface RewriteCandidate {
  toolId: string;
  evidence: RewriteEvidence;
}

/**
 * Rewrite candidates from match quality's worked failures: tools missed at
 * least `minMisses` times, with the distinct phrasings that missed or buried
 * them and what outranked them. Tools already taken by a merge are skipped.
 */
export function pickRewriteCandidates(
  candidates: readonly Candidate[],
  taken: ReadonlySet<string>,
  opts: { minMisses?: number; max?: number } = {},
): RewriteCandidate[] {
  const minMisses = opts.minMisses ?? REWRITE_MIN_MISSES;
  const out: RewriteCandidate[] = [];
  for (const candidate of [...candidates].sort((x, y) => y.loss - x.loss || y.misses - x.misses)) {
    if (candidate.misses < minMisses || taken.has(candidate.entryId)) continue;
    const missed = new Set<string>();
    const buried: { query: string; rank: number }[] = [];
    const distractors = new Map<string, number>();
    for (const failure of candidate.failures) {
      if (!failure.query) continue;
      if (failure.ourRank === null) missed.add(failure.query);
      else if (failure.ourRank > 1) buried.push({ query: failure.query, rank: failure.ourRank });
      if (failure.ourTop && failure.ourTop !== candidate.entryId)
        distractors.set(failure.ourTop, (distractors.get(failure.ourTop) ?? 0) + 1);
    }
    if (missed.size === 0 && buried.length === 0) continue;
    out.push({
      toolId: candidate.entryId,
      evidence: {
        missedQueries: [...missed],
        buriedQueries: buried,
        distractors: [...distractors]
          .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
          .map(([id]) => id),
      },
    });
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) break;
  }
  return out;
}

export interface FoldCandidate {
  /** The lookup. */
  a: string;
  /** The tool it feeds. */
  b: string;
  evidence: FoldEvidence;
}

/**
 * Fold candidates from every co-used pair (not only the always-together ones):
 * one side nearly always goes on to the other, the other often runs alone, and
 * the order is the lookup first. Tools a merge already took are skipped.
 */
export function pickFoldCandidates(
  pairs: readonly ExplorerSet[],
  edges: readonly ExplorerEdge[],
  taken: ReadonlySet<string>,
  opts: {
    minSupport?: number;
    minPAb?: number;
    maxPBa?: number;
    minNextP?: number;
    max?: number;
    nodes?: readonly ExplorerNode[];
  } = {},
): FoldCandidate[] {
  const minSupport = opts.minSupport ?? FOLD_MIN_SUPPORT;
  const minPAb = opts.minPAb ?? FOLD_MIN_P_AB;
  const maxPBa = opts.maxPBa ?? FOLD_MAX_P_BA;
  const out: FoldCandidate[] = [];
  const used = new Set(taken);
  for (const set of [...pairs].sort((x, y) => y.support - x.support)) {
    if (
      set.subject !== "tool" ||
      set.size !== 2 ||
      set.support < minSupport ||
      set.pAb === null ||
      set.pBa === null
    )
      continue;
    const [x, y] = set.items as [string, string];
    if (used.has(x) || used.has(y) || x.startsWith("skill:") || y.startsWith("skill:")) continue;
    // The lookup is the side whose units nearly all include the other.
    const lookupIsX = set.pAb >= minPAb && set.pBa < maxPBa;
    const lookupIsY = set.pBa >= minPAb && set.pAb < maxPBa;
    if (!lookupIsX && !lookupIsY) continue;
    const a = lookupIsX ? x : y;
    const b = lookupIsX ? y : x;
    const pAb = lookupIsX ? set.pAb : set.pBa;
    const pBa = lookupIsX ? set.pBa : set.pAb;
    const scoped = inScope(edges, set.scope);
    const d = direction(a, b, scoped);
    if (d.orderAb < 3 * Math.max(1, d.orderBa)) continue;
    if ((d.nextP ?? 0) < (opts.minNextP ?? FOLD_MIN_NEXT_P)) continue;
    out.push({
      a,
      b,
      evidence: {
        scope: set.scope,
        support: set.support,
        unitsA: Math.round(set.support / pAb),
        unitsB: Math.round(set.support / Math.max(pBa, 1e-9)),
        pAb,
        pBa,
        orderAb: d.orderAb,
        orderBa: d.orderBa,
        timing: pairTiming(a, b, scoped, opts.nodes ?? []),
      },
    });
    used.add(a);
    used.add(b);
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) break;
  }
  return out;
}

export interface DeprecateCandidate {
  toolId: string;
  replacement: string | null;
  evidence: DeprecateEvidence;
}

const NAME_STOPWORDS = new Set([
  "get",
  "list",
  "set",
  "the",
  "a",
  "an",
  "of",
  "by",
  "to",
  "for",
  "and",
  "or",
  "v1",
  "v2",
]);

/** A name word with a plural s dropped, so `tasks` and `task` are one word. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/**
 * Deprecate candidates: tools the runtime declares that nothing called in a
 * window of at least a month, paired with the used tool that shares the most
 * words of its name (the agent's pick when the two looked alike). Tools a
 * proposal already took are skipped.
 */
export function pickDeprecateCandidates(
  sources: readonly SourceTool[],
  nodes: readonly ExplorerNode[],
  windowDays: number,
  taken: ReadonlySet<string>,
  opts: { minWindowDays?: number; max?: number } = {},
): DeprecateCandidate[] {
  if (windowDays < (opts.minWindowDays ?? DEPRECATE_MIN_WINDOW_DAYS)) return [];
  const calls = new Map(nodes.filter((n) => n.subject === "tool").map((n) => [n.id, n.calls]));
  const used = sources.filter((s) => (calls.get(s.id) ?? 0) > 0);
  const out: DeprecateCandidate[] = [];
  for (const source of [...sources].sort((x, y) => x.id.localeCompare(y.id))) {
    if (taken.has(source.id) || (calls.get(source.id) ?? 0) > 0) continue;
    const words = new Set(
      nameParts(source.id)
        .filter((w) => !NAME_STOPWORDS.has(w))
        .map(stem),
    );
    let best: { tool: SourceTool; shared: string[] } | null = null;
    for (const candidate of used) {
      const shared = [...new Set(nameParts(candidate.id).map(stem))].filter((w) => words.has(w));
      if (
        shared.length > 0 &&
        (!best ||
          shared.length > best.shared.length ||
          (shared.length === best.shared.length &&
            (calls.get(candidate.id) ?? 0) > (calls.get(best.tool.id) ?? 0)))
      ) {
        best = { tool: candidate, shared };
      }
    }
    // Without a look-alike that is used, nothing says the capability is covered: leave the tool alone.
    if (!best) continue;
    out.push({
      toolId: source.id,
      replacement: best.tool.id,
      evidence: {
        windowDays,
        calls: 0,
        replacement: best.tool.id,
        replacementCalls: calls.get(best.tool.id) ?? 0,
        sharedWords: best.shared,
      },
    });
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chains, pairs that need no order, schemas the agent gets wrong first time,
// and hidden prerequisites. Each reads what the explorer or Agent health
// already stored; none reads arguments or outputs.

/**
 * A chain is composed only when its task runs in a fixed order by the one rule
 * Agent health's "Steps that always run in order" issue reads
 * (`workflows/fixed-order.ts`, env floors of `workflow_fixed_chain`), so the
 * issue and its fix appear together.
 */
export const COMPOSE_MIN_RUNS = DEFAULT_FLOORS.workflow_fixed_chain.minRuns;
export const COMPOSE_MIN_STABILITY = DEFAULT_FLOORS.workflow_fixed_chain.minOrderStability;
export const COMPOSE_MIN_STEPS = DEFAULT_FLOORS.workflow_fixed_chain.minCoreSize;
export const COMPOSE_MAX_STEPS = 6;
export const PARALLEL_MIN_SUPPORT = 10;
export const PARALLEL_MIN_JACCARD_LOW = 0.8;
/** Each order must hold at least this share of the ordered units: neither side waits for the other. */
export const PARALLEL_MIN_ORDER_SHARE = 0.3;
export const TIGHTEN_MIN_RETRIES = 3;
/** Of the retried errors, the share whose retry succeeded. */
export const TIGHTEN_MIN_RECOVERY = 0.5;
export const REQUIRE_MIN_CALLS = 5;
/** The error rate without the predecessor must exceed the rate with it by at least this. */
export const REQUIRE_MIN_GAP = 0.2;
/** With the predecessor, the tool must be about healthy. */
export const REQUIRE_MAX_RATE_WITH = 0.1;

/** A mined workflow as the crafter reads it, from Agent health's stored run. */
export interface WorkflowFact {
  id: string;
  typicalOrder: string[];
  orderStability: number;
  runs: number;
  medianMs: number | null;
  medianModelCalls: number | null;
  medianCostUsd: number | null;
}

export interface ComposeCandidate {
  order: string[];
  evidence: ComposeEvidence;
}

/** Chains of three or more tools that nearly always run in one order; a tool another proposal took disqualifies the chain. */
export function pickComposeCandidates(
  workflows: readonly WorkflowFact[],
  taken: ReadonlySet<string>,
  catalogIds: ReadonlySet<string>,
  opts: { minRuns?: number; minStability?: number; max?: number } = {},
): ComposeCandidate[] {
  const out: ComposeCandidate[] = [];
  const used = new Set(taken);
  for (const w of [...workflows].sort((x, y) => y.runs - x.runs || (x.id < y.id ? -1 : 1))) {
    const order = w.typicalOrder.filter((id) => !id.startsWith("skill:"));
    if (order.length < COMPOSE_MIN_STEPS || order.length > COMPOSE_MAX_STEPS) continue;
    if (
      w.runs < (opts.minRuns ?? COMPOSE_MIN_RUNS) ||
      w.orderStability < (opts.minStability ?? COMPOSE_MIN_STABILITY)
    )
      continue;
    if (order.some((id) => used.has(id) || !catalogIds.has(id))) continue;
    out.push({
      order,
      evidence: {
        workflowId: w.id,
        order,
        runs: w.runs,
        orderStability: w.orderStability,
        medianMs: w.medianMs,
        medianModelCalls: w.medianModelCalls,
        medianCostUsd: w.medianCostUsd,
      },
    });
    for (const id of order) used.add(id);
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) break;
  }
  return out;
}

export interface ParallelCandidate {
  a: string;
  b: string;
  evidence: ParallelEvidence;
}

/**
 * Pairs that are always both called and settle on no order: the `before`
 * counts go both ways in real numbers, and so do the consecutive runs. A
 * pair with one direction only is a dependency and belongs to merge or fold.
 */
export function pickParallelCandidates(
  sets: readonly ExplorerSet[],
  edges: readonly ExplorerEdge[],
  taken: ReadonlySet<string>,
  opts: {
    minSupport?: number;
    minJaccardLow?: number;
    minOrderShare?: number;
    max?: number;
    nodes?: readonly ExplorerNode[];
  } = {},
): ParallelCandidate[] {
  const out: ParallelCandidate[] = [];
  const used = new Set(taken);
  const minOrderShare = opts.minOrderShare ?? PARALLEL_MIN_ORDER_SHARE;
  for (const set of [...sets].sort((x, y) => y.support - x.support)) {
    if (
      set.subject !== "tool" ||
      set.size !== 2 ||
      set.support < (opts.minSupport ?? PARALLEL_MIN_SUPPORT) ||
      (set.jaccardLow ?? 0) < (opts.minJaccardLow ?? PARALLEL_MIN_JACCARD_LOW)
    )
      continue;
    const [a, b] = set.items as [string, string];
    if (used.has(a) || used.has(b) || a.startsWith("skill:") || b.startsWith("skill:")) continue;
    const scoped = inScope(edges, set.scope);
    const d = direction(a, b, scoped);
    const ordered = d.orderAb + d.orderBa;
    if (ordered === 0 || d.orderAb / ordered < minOrderShare || d.orderBa / ordered < minOrderShare)
      continue;
    const nextAb = scoped.find((e) => e.kind === "next" && e.a === a && e.b === b)?.n ?? 0;
    const nextBa = scoped.find((e) => e.kind === "next" && e.a === b && e.b === a)?.n ?? 0;
    const na = opts.nodes?.find((n) => n.id === a);
    const nb = opts.nodes?.find((n) => n.id === b);
    out.push({
      a,
      b,
      evidence: {
        scope: set.scope,
        support: set.support,
        jaccard: set.jaccard ?? 0,
        jaccardLow: set.jaccardLow ?? 0,
        orderAb: d.orderAb,
        orderBa: d.orderBa,
        nextAb,
        nextBa,
        aMedianMs: na?.medianMs ?? null,
        bMedianMs: nb?.medianMs ?? null,
      },
    });
    used.add(a);
    used.add(b);
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) break;
  }
  return out;
}

export interface TightenCandidate {
  toolId: string;
  evidence: TightenEvidence;
}

/** Argument names that read as a fixed set of values. */
const ENUM_LIKE =
  /(^|_)(status|state|type|kind|priority|mode|level|category|visibility|role|format)$/;

/** Tools whose errors are retried and the retry succeeds: the schema let the first call go wrong. */
export function pickTightenCandidates(
  tools: readonly ToolReliability[],
  sources: readonly SourceTool[],
  taken: ReadonlySet<string>,
  opts: { minRetries?: number; minRecovery?: number; max?: number } = {},
): TightenCandidate[] {
  const out: TightenCandidate[] = [];
  const byId = new Map(sources.map((s) => [s.id, s]));
  // A run that read the error messages and the recovery paths counts one thing: a straight retry that
  // worked after an error that named the argument. A recovery that went through a lookup is a
  // prerequisite (`pickRequireCandidates`), a bare "validation_failed" is reported but not claimed, and a
  // retry after not-found, a server error or a wrong tool name is not evidence. Older runs, which kept
  // none of that, count every recovered retry.
  const classed = (t: ToolReliability) =>
    t.retriedByClass !== undefined &&
    t.recoveredDirect !== undefined &&
    t.namedRecovered !== undefined;
  const evidenceCount = (t: ToolReliability) =>
    classed(t) ? t.namedRecovered! : t.recoveredRetries;
  for (const t of [...tools].sort(
    (x, y) => evidenceCount(y) - evidenceCount(x) || (x.toolId < y.toolId ? -1 : 1),
  )) {
    if (taken.has(t.toolId)) continue;
    if (classed(t)) {
      if (t.namedRecovered! < (opts.minRetries ?? TIGHTEN_MIN_RETRIES)) continue;
    } else if (
      t.retriedErrors < (opts.minRetries ?? TIGHTEN_MIN_RETRIES) ||
      t.recoveredRetries / Math.max(1, t.retriedErrors) < (opts.minRecovery ?? TIGHTEN_MIN_RECOVERY)
    )
      continue;
    const source = byId.get(t.toolId);
    if (!source) continue;
    const properties = source.inputSchema?.properties ?? {};
    const undocumentedArgs = Object.entries(properties)
      .filter(([, p]) => !p.description || p.description.trim().length === 0)
      .map(([name]) => name);
    const freeTextArgs = Object.entries(properties)
      .filter(
        ([name, p]) =>
          (p.type === "string" || (Array.isArray(p.type) && p.type.includes("string"))) &&
          !Array.isArray(p.enum) &&
          ENUM_LIKE.test(name),
      )
      .map(([name]) => name);
    const requiredArgs = Array.isArray(source.inputSchema?.required)
      ? source.inputSchema.required
      : [];
    out.push({
      toolId: t.toolId,
      evidence: {
        calls: t.calls,
        errorCalls: t.errorCalls,
        retriedErrors: t.retriedErrors,
        recoveredRetries: t.recoveredRetries,
        ...(classed(t)
          ? {
              namedRecovered: t.namedRecovered!,
              directRecovered: t.recoveredDirect!,
              viaLookup: t.recoveredVia ?? [],
              excludedRetried: t.retriedByClass!.not_found + t.retriedByClass!.server,
              namedArguments: t.namedArguments ?? [],
            }
          : {}),
        undocumentedArgs,
        freeTextArgs,
        requiredArgs,
      },
    });
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) break;
  }
  return out;
}

export interface RequireCandidate {
  /** The predecessor. */
  a: string;
  /** The tool that fails without it. */
  b: string;
  evidence: RequireEvidence;
}

/** Recoveries through one lookup a prerequisite needs before it is proposed from the recovery path. */
export const REQUIRE_MIN_VIA = 3;

/**
 * Two readings, the surer first. From the recovery path: a tool's failed call
 * recovered after the agent called a read tool in between, at least
 * `REQUIRE_MIN_VIA` times; the lookup is what the call was missing. From
 * the rates: a tool fails mostly when a given tool did not run earlier in
 * the turn, and is about healthy when it did.
 */
export function pickRequireCandidates(
  rows: readonly PrerequisiteReliability[],
  taken: ReadonlySet<string>,
  opts: {
    minCalls?: number;
    minGap?: number;
    maxRateWith?: number;
    minVia?: number;
    max?: number;
  } = {},
  recovery: { tools: readonly ToolReliability[]; sources: readonly SourceTool[] } = {
    tools: [],
    sources: [],
  },
): RequireCandidate[] {
  const out: RequireCandidate[] = [];
  const used = new Set(taken);
  const minCalls = opts.minCalls ?? REQUIRE_MIN_CALLS;
  const byId = new Map(recovery.sources.map((s) => [s.id, s]));
  const rateOf = new Map(rows.map((r) => [`${r.a}|${r.b}`, r]));
  const fromPaths = recovery.tools
    .flatMap((t) => (t.recoveredVia ?? []).map((v) => ({ t, via: v.tool, n: v.n })))
    .filter(
      (x) =>
        x.n >= (opts.minVia ?? REQUIRE_MIN_VIA) && byId.has(x.via) && isReadTool(byId.get(x.via)!),
    )
    .sort((x, y) => y.n - x.n || (x.t.toolId < y.t.toolId ? -1 : 1));
  for (const { t, via, n } of fromPaths) {
    if (
      used.has(via) ||
      used.has(t.toolId) ||
      via.startsWith("skill:") ||
      t.toolId.startsWith("skill:")
    )
      continue;
    const rate = rateOf.get(`${via}|${t.toolId}`);
    out.push({
      a: via,
      b: t.toolId,
      evidence: {
        withA: rate?.withA ?? { calls: 0, errors: 0 },
        withoutA: rate?.withoutA ?? { calls: t.calls, errors: t.errorCalls },
        recovery: { retried: t.retriedErrors, recovered: t.recoveredRetries, via: n },
      },
    });
    used.add(via);
    used.add(t.toolId);
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) return out;
  }
  const scored = rows
    .filter((r) => r.withA.calls >= minCalls && r.withoutA.calls >= minCalls)
    .map((r) => ({
      r,
      gap: r.withoutA.errors / r.withoutA.calls - r.withA.errors / r.withA.calls,
      rateWith: r.withA.errors / r.withA.calls,
    }))
    .filter(
      (x) =>
        x.gap >= (opts.minGap ?? REQUIRE_MIN_GAP) &&
        x.rateWith <= (opts.maxRateWith ?? REQUIRE_MAX_RATE_WITH),
    )
    .sort(
      (x, y) =>
        y.gap - x.gap || y.r.withoutA.errors - x.r.withoutA.errors || (x.r.b < y.r.b ? -1 : 1),
    );
  for (const { r } of scored) {
    if (used.has(r.a) || used.has(r.b) || r.a.startsWith("skill:") || r.b.startsWith("skill:"))
      continue;
    out.push({ a: r.a, b: r.b, evidence: { withA: r.withA, withoutA: r.withoutA } });
    used.add(r.a);
    used.add(r.b);
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) break;
  }
  return out;
}

// --- per-ask rules: what one ask's units always do ---------------------------

/** One ask as the crafter reads it: its units, tool shares, sure hops and first calls, turn scope. */
export interface IntentFact {
  intentId: string;
  text: string | null;
  units: number;
  tools: { toolId: string; n: number }[];
  edges: StoredIntentEdge[];
  firsts: StoredIntentFirst[];
  /** Calls the ask's units made in all; 0 on runs stored before it was kept. */
  calls: number;
}

/** A hop inside one ask must hold `SURE_HOP_P` of the time over this many calls before it is a dependency worth a proposal. */
export const ASK_HOP_MIN_N = 3;
/** An ask must open with the same tool this often to call that tool setup. */
export const PRELOAD_MIN_SHARE = 0.9;

const READ_VERBS =
  /^(get|list|search|find|filter|fetch|lookup|look_up|describe|show|count|check|read|query|download|view|browse|retrieve|load|resolve|whoami|status)(_|$)/;
const WRITE_VERBS =
  /^(create|update|delete|remove|add|set|link|unlink|assign|complete|post|send|edit|manage|approve|reject|publish|archive|move|rename|upload|run|execute|trigger|start|stop|mark|close|open|reopen|schedule|cancel|merge|split|import|export|sync|apply|revert|generate|write|save|notify|comment|reply|invite|grant|revoke|toggle|enable|disable|clear|reset|restore|attach|detach|tag|untag)(_|$)/;

/**
 * Whether a tool reads rather than changes, from its name's verb, then its
 * description. Unknown verbs count as reads only when the description says
 * so ("returns", "lists", "fetches") and never says it changes anything.
 */
export function isReadTool(tool: Pick<SourceTool, "id" | "name" | "description">): boolean {
  const stem = nameParts(tool.name || tool.id).join("_");
  if (WRITE_VERBS.test(stem)) return false;
  if (READ_VERBS.test(stem)) return true;
  const text = tool.description.toLowerCase();
  if (
    /\b(creates?|updates?|deletes?|removes?|adds?|sets?|assigns?|sends?|posts?|writes?|modif(?:y|ies)|changes?|links?|unlinks?|marks?|publish(?:es)?|archives?)\b/.test(
      text,
    )
  )
    return false;
  return /\b(returns?|lists?|fetch(?:es)?|retrieves?|looks? up|reads?|searches|gets?|shows?)\b/.test(
    text,
  );
}

export interface EnrichCandidate {
  a: string;
  b: string;
  evidence: EnrichEvidence;
}

/**
 * Inside one ask, b (a read) came right after a in at least `minP` of a's
 * calls, over at least `minN` calls: a's response is missing what b fetches.
 * One proposal per pair, from the ask where the hop is biggest; a pair another
 * proposal took is skipped, as is one where a is itself the opening lookup
 * (that is a pre-load).
 */
export function pickEnrichCandidates(
  intents: readonly IntentFact[],
  sources: readonly SourceTool[],
  nodes: readonly { id: string; turnUnits: number; medianMs?: number | null }[],
  taken: ReadonlySet<string>,
  opts: { minP?: number; minN?: number; max?: number } = {},
): EnrichCandidate[] {
  const minP = opts.minP ?? SURE_HOP_P;
  const minN = opts.minN ?? ASK_HOP_MIN_N;
  const byId = new Map(sources.map((s) => [s.id, s]));
  const nodeOf = new Map(nodes.map((n) => [n.id, n]));
  const best = new Map<string, { intent: IntentFact; edge: StoredIntentEdge }>();
  for (const intent of intents)
    for (const edge of intent.edges) {
      if (edge.a === edge.b || edge.n < minN || edge.na === 0 || edge.n / edge.na < minP) continue;
      const b = byId.get(edge.b);
      if (!byId.has(edge.a) || !b || !isReadTool(b)) continue;
      const key = `${edge.a}>${edge.b}`;
      const have = best.get(key);
      if (!have || edge.n > have.edge.n) best.set(key, { intent, edge });
    }
  const out: EnrichCandidate[] = [];
  const used = new Set(taken);
  const ranked = [...best.values()].sort(
    (x, y) =>
      wilsonLow(y.edge.n, y.edge.na) - wilsonLow(x.edge.n, x.edge.na) ||
      y.edge.n - x.edge.n ||
      (x.edge.a < y.edge.a ? -1 : 1),
  );
  for (const { intent, edge } of ranked) {
    if (used.has(edge.a) || used.has(edge.b)) continue;
    const bNode = nodeOf.get(edge.b);
    const bInAsk = intent.tools.find((t) => t.toolId === edge.b)?.n ?? 0;
    out.push({
      a: edge.a,
      b: edge.b,
      evidence: {
        intentId: intent.intentId,
        intentText: intent.text,
        units: intent.units,
        a: edge.a,
        b: edge.b,
        n: edge.n,
        na: edge.na,
        bMedianMs: bNode?.medianMs ?? null,
        bUnitsOutside: Math.max(0, (bNode?.turnUnits ?? 0) - bInAsk),
      },
    });
    used.add(edge.a);
    used.add(edge.b);
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) break;
  }
  return out;
}

export interface PreloadCandidate {
  toolId: string;
  evidence: PreloadEvidence;
}

/**
 * An ask whose units open with the same read tool at least `minShare` of the
 * time (over `minN` units): the lookup is setup the agent could be handed
 * before the turn starts. One proposal per tool, from the ask where it is
 * surest.
 */
export function pickPreloadCandidates(
  intents: readonly IntentFact[],
  sources: readonly SourceTool[],
  nodes: readonly { id: string; medianMs?: number | null }[],
  taken: ReadonlySet<string>,
  opts: { minShare?: number; minN?: number; max?: number } = {},
): PreloadCandidate[] {
  const minShare = opts.minShare ?? PRELOAD_MIN_SHARE;
  const minN = opts.minN ?? ASK_HOP_MIN_N;
  const byId = new Map(sources.map((s) => [s.id, s]));
  const nodeOf = new Map(nodes.map((n) => [n.id, n]));
  const best = new Map<string, { intent: IntentFact; first: StoredIntentFirst }>();
  for (const intent of intents) {
    const first = intent.firsts[0];
    if (!first || intent.units === 0 || first.n < minN || first.n / intent.units < minShare)
      continue;
    const tool = byId.get(first.t);
    if (!tool || !isReadTool(tool)) continue;
    const have = best.get(first.t);
    if (!have || first.n > have.first.n) best.set(first.t, { intent, first });
  }
  const out: PreloadCandidate[] = [];
  const used = new Set(taken);
  const ranked = [...best.values()].sort(
    (x, y) =>
      wilsonLow(y.first.n, y.intent.units) - wilsonLow(x.first.n, x.intent.units) ||
      y.first.n - x.first.n ||
      (x.first.t < y.first.t ? -1 : 1),
  );
  for (const { intent, first } of ranked) {
    if (used.has(first.t)) continue;
    out.push({
      toolId: first.t,
      evidence: {
        intentId: intent.intentId,
        intentText: intent.text,
        units: intent.units,
        tool: first.t,
        firstN: first.n,
        medianMs: nodeOf.get(first.t)?.medianMs ?? null,
      },
    });
    used.add(first.t);
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) break;
  }
  return out;
}

export interface SplitByUseCandidate {
  toolId: string;
  evidence: SplitByUseEvidence;
}

/**
 * One tool, different sure followers under different asks: under ask A it is
 * always followed by X, under ask B always by Y. Its output is being used two
 * ways, which is the honest reason to split it (or to return both). Needs
 * two asks with distinct followers, each a sure hop.
 */
export function pickSplitByUseCandidates(
  intents: readonly IntentFact[],
  sources: readonly SourceTool[],
  taken: ReadonlySet<string>,
  opts: { minP?: number; minN?: number; max?: number } = {},
): SplitByUseCandidate[] {
  const minP = opts.minP ?? SURE_HOP_P;
  const minN = opts.minN ?? ASK_HOP_MIN_N;
  const byId = new Map(sources.map((s) => [s.id, s]));
  const uses = new Map<string, SplitByUseEvidence["uses"]>();
  for (const intent of intents) {
    // The ask's surest follower per tool.
    const best = new Map<string, StoredIntentEdge>();
    for (const edge of intent.edges) {
      if (edge.a === edge.b || edge.n < minN || edge.na === 0 || edge.n / edge.na < minP) continue;
      const have = best.get(edge.a);
      if (!have || edge.n > have.n) best.set(edge.a, edge);
    }
    for (const [toolId, edge] of best) {
      if (!byId.has(toolId) || !byId.has(edge.b)) continue;
      const list = uses.get(toolId) ?? [];
      list.push({
        intentId: intent.intentId,
        intentText: intent.text,
        units: intent.units,
        follower: edge.b,
        n: edge.n,
        na: edge.na,
      });
      uses.set(toolId, list);
    }
  }
  const out: SplitByUseCandidate[] = [];
  const ranked = [...uses.entries()]
    .map(([toolId, list]) => ({
      toolId,
      list: list.sort((x, y) => y.n - x.n || (x.intentId < y.intentId ? -1 : 1)),
    }))
    .filter(({ list }) => new Set(list.map((u) => u.follower)).size >= 2)
    .sort(
      (x, y) =>
        y.list.reduce((sum, u) => sum + u.n, 0) - x.list.reduce((sum, u) => sum + u.n, 0) ||
        (x.toolId < y.toolId ? -1 : 1),
    );
  // A split claims the tool and its followers, so a later split cannot name them again.
  const used = new Set(taken);
  for (const { toolId, list } of ranked) {
    // One use per follower, the biggest ask for each, so the row reads as "two ways".
    const seen = new Set<string>();
    const uses = list
      .filter((u) => (seen.has(u.follower) ? false : (seen.add(u.follower), true)))
      .slice(0, 4);
    const tools = [toolId, ...uses.map((u) => u.follower)];
    if (tools.some((id) => used.has(id))) continue;
    out.push({ toolId, evidence: { toolId, uses } });
    for (const id of tools) used.add(id);
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) break;
  }
  return out;
}

export interface GapCandidate {
  intentId: string;
  evidence: GapEvidence;
}

/** An ask needs this many units, this many distinct tools, no sure hop, and this many times the project's calls per unit, to be a gap. */
export const GAP_MIN_UNITS = 10;
export const GAP_MIN_TOOLS = 6;
export const GAP_MIN_CALL_RATIO = 1.5;

/**
 * Asks the catalog does not answer directly: no sure hop, many distinct
 * tools, far more calls per unit than the project's norm. The agent is
 * improvising a path every time. The proposal is a tool that does not exist
 * yet, named from the ask's words, with the tools it would replace.
 */
export function pickGapCandidates(
  intents: readonly IntentFact[],
  projectCallsPerUnit: number | null,
  catalogIds: ReadonlySet<string>,
  taken: ReadonlySet<string>,
  opts: {
    minUnits?: number;
    minTools?: number;
    minRatio?: number;
    minP?: number;
    minN?: number;
    max?: number;
  } = {},
): GapCandidate[] {
  if (projectCallsPerUnit === null || projectCallsPerUnit <= 0) return [];
  const minP = opts.minP ?? SURE_HOP_P;
  const minN = opts.minN ?? ASK_HOP_MIN_N;
  const out: GapCandidate[] = [];
  const scored = intents
    .filter(
      (i) =>
        i.units >= (opts.minUnits ?? GAP_MIN_UNITS) &&
        i.calls > 0 &&
        i.tools.length >= (opts.minTools ?? GAP_MIN_TOOLS),
    )
    .filter(
      (i) => !i.edges.some((e) => e.a !== e.b && e.n >= minN && e.na > 0 && e.n / e.na >= minP),
    )
    .map((i) => ({ i, ratio: i.calls / i.units / projectCallsPerUnit }))
    .filter(({ ratio }) => ratio >= (opts.minRatio ?? GAP_MIN_CALL_RATIO))
    .sort((x, y) => y.i.calls - x.i.calls || (x.i.intentId < y.i.intentId ? -1 : 1));
  // Two asks improvised over the same tools make one new tool, not two.
  const used = new Set(taken);
  for (const { i } of scored) {
    const topTools = [...i.tools]
      .sort((x, y) => y.n - x.n || (x.toolId < y.toolId ? -1 : 1))
      .slice(0, 4);
    if (topTools.some((t) => used.has(t.toolId))) continue;
    for (const t of topTools) used.add(t.toolId);
    out.push({
      intentId: i.intentId,
      evidence: {
        intentId: i.intentId,
        intentText: i.text,
        units: i.units,
        calls: i.calls,
        callsPerUnit: i.calls / i.units,
        projectCallsPerUnit,
        distinctTools: i.tools.length,
        topTools,
        suggestedName: gapToolName(i.text ?? i.intentId, catalogIds),
      },
    });
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) break;
  }
  return out;
}

const NAME_FILLER = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "for",
  "in",
  "on",
  "at",
  "by",
  "with",
  "and",
  "or",
  "it",
  "its",
  "this",
  "that",
  "me",
  "my",
  "i",
  "we",
  "you",
  "is",
  "are",
  "be",
  "do",
  "does",
  "please",
  "can",
  "could",
  "would",
  "want",
  "need",
  "all",
  "from",
  "as",
  "into",
  "about",
  "then",
  "also",
  "some",
  "any",
  "up",
  "specific",
  "single",
  "full",
  "including",
  "get",
  "show",
  "find",
  "please",
]);

/** "summarise the sprint for my team" → `summarise_sprint_team`; a name the catalog does not have. */
export function gapToolName(askText: string, catalogIds: ReadonlySet<string>): string {
  const words = askText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !NAME_FILLER.has(w));
  const base = (words.length > 0 ? words.slice(0, 3) : ["answer", "ask"]).join("_");
  let name = base;
  for (let i = 2; catalogIds.has(name); i += 1) name = `${base}_${i}`;
  return name;
}
