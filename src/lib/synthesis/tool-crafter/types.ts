/**
 * Shared shapes of the Tool Crafter (RC-231): proposals to rewrite a project's
 * tools from what the Tool Explorer saw. A proposal is drafted by rules from
 * the source definitions and the evidence and shown as a suggestion; no model
 * writes or rewrites it. Everything here is plain data.
 */

export const CRAFT_KINDS = [
  "merge_tools",
  "rewrite_tool",
  "fold_prerequisite",
  "deprecate_tool",
  "compose_chain",
  "parallel_pair",
  "tighten_schema",
  "enrich_response",
  "preload_context",
  "split_by_use",
  "fill_gap",
  "require_prerequisite",
] as const;
export type CraftKind = (typeof CRAFT_KINDS)[number];

/** `pending` until a newer run supersedes it. Nothing is approved here: a proposal is acted on in the customer's code. */
/**
 * `pending` until the next run supersedes it; `dismissed` when a person said no
 * on Fixes, which also keeps the next runs from drafting the same change again.
 */
export const CRAFT_STATUSES = ["pending", "superseded", "dismissed"] as const;
export type CraftStatus = (typeof CRAFT_STATUSES)[number];

/** A JSON Schema object as the catalog stores it; only the parts the drafter reads are typed. */
export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  description?: string;
  additionalProperties?: boolean | Record<string, unknown>;
  [key: string]: unknown;
}

export interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  [key: string]: unknown;
}

/** A tool as the runtime last described it, read from the catalog tables. */
export interface SourceTool {
  id: string;
  name: string;
  description: string;
  searchableDescription: string | null;
  inputSchema: JsonSchemaObject | null;
}

/**
 * How one old tool's call maps onto the crafted tool. `argumentMapping`
 * renames; `derived` says where a source argument comes from when it is no
 * longer an argument of the crafted tool at all: an earlier source's result
 * (`"<sourceToolId>.output.<path>"`, so a merge find→assign can drop `task_id`)
 * or a fixed value (`"literal:<json>"`, the mode a split piece pins). `order`
 * is the call order inside the crafted handler. Both are optional so every
 * stored row stays valid.
 */
export interface DispatchNote {
  sourceToolId: string;
  /** When the crafted tool should behave as this source did, in plain words. */
  when: string;
  /** Old argument name to new argument name, for every renamed argument. */
  argumentMapping: Record<string, string>;
  /** Source argument name to its origin, for arguments the crafted tool no longer takes. */
  derived?: Record<string, string>;
  /** Position in the crafted handler's call sequence, 0 first. */
  order?: number;
}

export interface CraftedToolDefinition {
  name: string;
  /** The description the agent reads. */
  description: string;
  /** The text retrieval matches against. */
  searchableDescription: string;
  inputSchema: JsonSchemaObject;
  /** Plain prose on what the tool returns; the catalog stores output schemas optionally. */
  outputNotes: string | null;
  dispatch: DispatchNote[];
}

export interface CraftedProposalBody {
  kind: CraftKind;
  /** Every existing tool the proposal touches. */
  sourceToolIds: string[];
  /** One for merge/rewrite/fold, two or more for split, none for deprecate. */
  crafted: CraftedToolDefinition[];
  /** Source tools the proposal retires; a subset of `sourceToolIds`. */
  hidden: string[];
  /** One plain sentence. */
  rationale: string;
  /** The audit: what the evidence showed, in a few sentences. */
  details: string;
  expectedEffect: string;
  /** The code change the customer makes, in plain words. */
  migrationNotes: string;
}

/** The explorer facts a merge draft is built from. */
export interface MergeEvidence {
  scope: "turn" | "session";
  support: number;
  unitsA: number;
  unitsB: number;
  jaccard: number;
  jaccardLow: number;
  /** Share of A's units that also ran B, and the reverse. */
  pAb: number;
  pBa: number;
  /** How often A's call came right before B's; null when the pair runs either way around. */
  nextP: number | null;
  /** Units that ran A then B, and B then A. */
  orderAb: number;
  orderBa: number;
  exampleSessions: string[];
  /** What the pair costs in time over the window, when the ledger timed it. */
  timing?: PairTiming;
  /**
   * Set when the pair is one intent's own two-tool pattern
   * (`pickIntentMergeCandidates`): the intent by id (its name is read where
   * the fix is shown, never stored here), its turns, and the turns that ran
   * both. The counts above are then read inside the intent's turns.
   */
  intent?: { topicId: string; turns: number; runs: number };
}

/**
 * Time facts for a pair, from the Explorer's node and edge timing. The
 * hand-off (a's end to b's start, both directions) plus the searches in it is
 * what one tool instead of two removes; the tools' own run time stays.
 */
export interface PairTiming {
  aCalls: number;
  bCalls: number;
  aMedianMs: number | null;
  bMedianMs: number | null;
  aTotalMs: number;
  bTotalMs: number;
  /** Consecutive pairs with both timestamps, either order. */
  handoffPairs: number;
  handoffMsTotal: number;
  handoffMsMedian: number | null;
  searchesBetween: number;
}

/** The deficits a rewrite draft is built from. */
export interface RewriteEvidence {
  /** Queries that should have found the tool and did not, deduplicated. */
  missedQueries: string[];
  /** Queries that found it at a buried rank, with that rank. */
  buriedQueries: { query: string; rank: number }[];
  /** Tools that outranked it on those queries, most often first. */
  distractors: string[];
}

/** A lookup that only ever precedes one other tool. */
export interface FoldEvidence {
  scope: "turn" | "session";
  support: number;
  unitsA: number;
  unitsB: number;
  /** Share of the lookup's units that went on to the main tool, and the reverse. */
  pAb: number;
  pBa: number;
  orderAb: number;
  orderBa: number;
  timing?: PairTiming;
}

/** A declared tool nothing called, and the used tool whose name it shares words with. */
export interface DeprecateEvidence {
  windowDays: number;
  calls: number;
  replacement: string | null;
  replacementCalls: number;
  sharedWords: string[];
}

/** A fixed chain Agent health mined: the same tools, in the same order, run after run. */
export interface ComposeEvidence {
  workflowId: string;
  /** The chain in its usual order. */
  order: string[];
  runs: number;
  /** Share of runs whose first calls follow `order`. */
  orderStability: number;
  medianMs: number | null;
  /** Median model calls per run, when OpenTelemetry linked them; one call per step is what the chain costs. */
  medianModelCalls: number | null;
  medianCostUsd: number | null;
}

/** Two tools always both called, in no settled order: nothing in the ledger says one needs the other. */
export interface ParallelEvidence {
  scope: "turn" | "session";
  support: number;
  jaccard: number;
  jaccardLow: number;
  /** Units that ran A first, and B first. */
  orderAb: number;
  orderBa: number;
  /** Consecutive runs a→b and b→a as the ledger saw them; a dependency would show as one direction only. */
  nextAb: number;
  nextBa: number;
  aMedianMs: number | null;
  bMedianMs: number | null;
}

/** A tool whose errors are followed by a retry of the same tool that succeeds: the first call was shaped wrong. */
export interface TightenEvidence {
  calls: number;
  errorCalls: number;
  retriedErrors: number;
  recoveredRetries: number;
  /** Recovered straight retries (nothing called in between) whose error named an argument: the failures a schema fix is known to address. Absent on evidence stored before messages were read. */
  namedRecovered?: number;
  /** Recovered straight retries in all, named or not; the unnamed ones are reported, not claimed. */
  directRecovered?: number;
  /** Recovered retries that went through another tool first, by that tool: a lookup the agent needed, which is a prerequisite rather than a schema matter. */
  viaLookup?: { tool: string; n: number }[];
  /** Retried errors known not to be about the schema: not found, server-side, or a call under a name that is not the tool's. */
  excludedRetried?: number;
  /** Arguments the validation errors named, commonest first. */
  namedArguments?: string[];
  /** Arguments the schema declares without a description. */
  undocumentedArgs: string[];
  /** String arguments whose name reads like a fixed set of values but that carry no enum. */
  freeTextArgs: string[];
  /** Arguments the schema requires. */
  requiredArgs: string[];
}

/** Inside one ask, a read tool always follows another tool: the first tool's response is missing what the second fetches. */
export interface EnrichEvidence {
  intentId: string;
  intentText: string | null;
  /** The ask's units in the window. */
  units: number;
  a: string;
  b: string;
  /** Calls of a in the ask's units, and how many b came right after. */
  n: number;
  na: number;
  /** b's median duration across the project, when timed. */
  bMedianMs: number | null;
  /** Turns calling b outside this ask, across the project: how much of b's traffic is just this hop. */
  bUnitsOutside: number;
}

/** One ask's units open with the same read tool nearly every time: that lookup is setup, not a decision. */
export interface PreloadEvidence {
  intentId: string;
  intentText: string | null;
  units: number;
  tool: string;
  /** Units of the ask that opened with the tool. */
  firstN: number;
  medianMs: number | null;
}

/** One tool whose sure follower differs by ask: its output is read two different ways. */
export interface SplitByUseEvidence {
  toolId: string;
  /** Per ask, what came right after the tool, and how surely. */
  uses: {
    intentId: string;
    intentText: string | null;
    units: number;
    follower: string;
    n: number;
    na: number;
  }[];
}

/** An ask the catalog answers with no fixed path: many tools, many calls per unit, no sure hop. */
export interface GapEvidence {
  intentId: string;
  intentText: string | null;
  units: number;
  calls: number;
  callsPerUnit: number;
  projectCallsPerUnit: number;
  distinctTools: number;
  /** The tools the ask reaches most, with the units that called each. */
  topTools: { toolId: string; n: number }[];
  /** A name for the tool that would answer the ask directly, from the ask's words. */
  suggestedName: string;
}

/** A tool that fails mostly when another tool did not run earlier in the turn. */
export interface RequireEvidence {
  withA: { calls: number; errors: number };
  withoutA: { calls: number; errors: number };
  /** When the evidence is the recovery path: b's retried errors, how many recovered, and how many recovered by calling a in between. */
  recovery?: { retried: number; recovered: number; via: number };
}

export type CraftEvidence =
  | { kind: "merge_tools"; merge: MergeEvidence }
  | { kind: "compose_chain"; compose: ComposeEvidence }
  | { kind: "parallel_pair"; parallel: ParallelEvidence }
  | { kind: "tighten_schema"; tighten: TightenEvidence }
  | { kind: "enrich_response"; enrich: EnrichEvidence }
  | { kind: "preload_context"; preload: PreloadEvidence }
  | { kind: "split_by_use"; splitByUse: SplitByUseEvidence }
  | { kind: "fill_gap"; gap: GapEvidence }
  | { kind: "require_prerequisite"; require: RequireEvidence }
  | { kind: "rewrite_tool"; rewrite: RewriteEvidence }
  | { kind: "fold_prerequisite"; fold: FoldEvidence }
  | { kind: "deprecate_tool"; deprecate: DeprecateEvidence };
