import type { StoredReliability } from "@/lib/readings/tool-explorer/reliability";

/**
 * Shared shapes of the Tool Explorer (RC-231): which tools an agent runs
 * together, read off the Agent health turn ledger per turn and per session.
 * Everything here is plain data so a run's result can go to the database and
 * come back for the page and the MCP tools unchanged.
 */

/** The unit a reading is counted over: one closed turn, or one session's turns. */
export type ExplorerScope = "turn" | "session";
export const EXPLORER_SCOPES: readonly ExplorerScope[] = ["turn", "session"];

/** What the ids in an edge or a set name. */
export type ExplorerSubject = "tool" | "intent";

/**
 * `next`: b was the call right after a (repeats of a collapsed), so `p` is the
 * chance the agent's next tool after a is b. `before`: a's first call came
 * before b's first call in the unit, counted once per unit, the convention of
 * Agent health's `pairs.ts`.
 */
export type ExplorerEdgeKind = "next" | "before";

/**
 * One unit as the explorer reads it: the ids called, in order, with immediate
 * repeats collapsed, and the distinct ids sorted. A session unit is its turns'
 * calls concatenated in time order.
 */
export interface ExplorerUnit {
  id: string;
  sessionId: string;
  /** Ids in call order, immediate repeats collapsed. */
  calls: readonly string[];
  /** Distinct ids, sorted. */
  items: readonly string[];
}

export interface ExplorerEdge {
  scope: ExplorerScope;
  kind: ExplorerEdgeKind;
  subject: ExplorerSubject;
  a: string;
  b: string;
  /** Units (or calls, for `next`) where b followed a. */
  n: number;
  /** The denominator: units that called a (`before`), or calls of a with a successor (`next`). */
  nA: number;
  /** `n / nA`. */
  p: number;
  pLow: number;
  pHigh: number;
  /** `p` over the base rate of b: `p / (unitsB / units)`. */
  lift: number;
  /** The opposite edge's `n`, so a one-way dependency reads differently from a pair that runs either way. */
  reverseN: number;
  exampleSessions: readonly string[];
  /**
   * `next` edges only: the hand-off between a's end and b's start, summed over
   * the pairs that had both timestamps, with the median, and how many searches
   * sat between them. What a merge of the two would remove.
   */
  timing?: EdgeTiming;
}

export interface EdgeTiming {
  /** Pairs with both timestamps. */
  pairs: number;
  betweenMsTotal: number;
  betweenMsMedian: number | null;
  searchesBetween: number;
}

export interface ExplorerSet {
  scope: ExplorerScope;
  subject: ExplorerSubject;
  /** Sorted ids joined by `|`. */
  key: string;
  items: readonly string[];
  size: number;
  /** Units containing every item. */
  support: number;
  /** `support` over units with at least one call. */
  share: number;
  /** Pairs only: `support / |units with a or b|`, and its Wilson lower bound. */
  jaccard: number | null;
  jaccardLow: number | null;
  /** Pairs only: `support / unitsA` and `support / unitsB`. */
  pAb: number | null;
  pBa: number | null;
  /** The task (Agent health workflow) with these core tools, when one exists. */
  workflowId: string | null;
  exampleSessions: readonly string[];
}

/** One id's footprint in a run. */
export interface ExplorerNode {
  id: string;
  subject: ExplorerSubject;
  /** Calls across every unit (a tool called three times in a turn counts three). */
  calls: number;
  /** Turns that called it at least once. */
  turnUnits: number;
  /** Sessions that called it at least once. */
  sessionUnits: number;
  /** Summed `took_ms` over the calls that reported one, and their median. */
  totalMs?: number;
  medianMs?: number | null;
  timedCalls?: number;
  errorCalls?: number;
}

export interface ExplorerScopeCounts {
  /** Units with at least one call. */
  units: number;
  /** Units with two or more distinct ids: the co-usage population. */
  multiUnits: number;
}

/** Which tools serve an intent: one row per (scope, intent, tool). */
export interface IntentToolShare {
  scope: ExplorerScope;
  /** A `query_intents.id`. */
  intentId: string;
  /** Units carrying the intent (and at least one call). */
  intentUnits: number;
  toolId: string;
  /** Of those units, how many called the tool. */
  n: number;
  share: number;
  shareLow: number;
}

/** Intents whose texts share enough words to read as one ask; lexical only. */
/** One ordered chain for an intent: the tools in call order, and how many of its units ran exactly that. */
export interface StoredIntentChain {
  t: string[];
  n: number;
}

/** One next-call edge inside an intent's units: a then b `n` times, of `na` times a was followed by anything. */
export interface StoredIntentEdge {
  a: string;
  b: string;
  n: number;
  /** Calls of a in the intent's units, the units' last calls included; n / na is how surely b follows a. */
  na: number;
}

/** One tool an intent's units opened with, in `n` of them. */
export interface StoredIntentFirst {
  t: string;
  n: number;
}

export interface IntentGroup {
  id: string;
  label: string;
  intentIds: string[];
}

/** What the run stores besides its edge and set rows. */
export interface ExplorerSummary {
  version: 1;
  units: Record<ExplorerScope, ExplorerScopeCounts>;
  nodes: ExplorerNode[];
  /** Present once the intent join ran: how many units carried an intent, per scope. */
  intentUnits?: Record<ExplorerScope, number>;
  intentGroups?: IntentGroup[];
  /** Per scope and intent, the commonest ordered call chains of the units that carried it. */
  intentChains?: Partial<Record<ExplorerScope, Record<string, StoredIntentChain[]>>>;
  /** Per scope and intent, the next-call edges of the units that carried it. */
  intentEdges?: Partial<Record<ExplorerScope, Record<string, StoredIntentEdge[]>>>;
  /** Per scope and intent, what its units called first. */
  intentFirsts?: Partial<Record<ExplorerScope, Record<string, StoredIntentFirst[]>>>;
  /** Per scope and intent, the calls its units made in all (repeats collapsed): calls per unit is this over the units. */
  intentCalls?: Partial<Record<ExplorerScope, Record<string, number>>>;
  /** Per tool, errors and retries; per pair, a tool's error rate with and without another tool earlier in the turn. Turn scope. */
  reliability?: StoredReliability;
  truncated: {
    /** The session fold hit `MAX_SESSIONS` or a session hit `MAX_CALLS_PER_SESSION`. */
    sessions: boolean;
    /** The stored edges or sets were cut to the row caps, by scope. */
    edges: Partial<Record<ExplorerScope, boolean>>;
    sets: Partial<Record<ExplorerScope, boolean>>;
  };
}

export interface ExplorerResult {
  edges: ExplorerEdge[];
  sets: ExplorerSet[];
  intentTools: IntentToolShare[];
  summary: ExplorerSummary;
  turnsScanned: number;
  sessionsScanned: number;
  /** Turns that carried at least one extracted intent. */
  turnsWithIntents: number;
}

/** A mined Agent health workflow's identity, enough to match a co-used set to it. */
export interface ExplorerWorkflowCore {
  id: string;
  coreTools: readonly string[];
}

export const EXPLORER_SUMMARY_VERSION = 1 as const;
