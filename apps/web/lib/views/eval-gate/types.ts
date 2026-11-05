import type { LineageRef } from "@/lib/views/lineage/types";
import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import type { ReplayWork } from "@/lib/views/task-scorers/replay";

/**
 * The eval gate (RC-46): every fix gets a set of the project's own historical
 * runs, what each should do once the fix is made, and a simulation that replays
 * them with the fix applied. Pure types, client-safe.
 *
 * A simulation never touches the customer's environment: it reads stored runs
 * (the turn ledger) and the catalog, and recomputes in-process.
 */

/* - The change a simulation applies ----------------------------------------- */

/** A tool the change adds to the catalog (a crafted merge), and the tools it stands in for. */
export interface AddedTool {
  id: string;
  name: string;
  searchable: string;
  /** Tools whose calls and list places it takes over. */
  replaces: string[];
}

/**
 * What a fix changes, as the simulator applies it. Every part optional: a
 * change with none of them cannot be simulated (`unsupportedReason` says why).
 * Stored on the eval set as JSON, so a re-run replays the same change.
 */
export interface FixChange {
  version: 1;
  /** Catalog entry id → its new searchable text (a rewrite). */
  patches: Record<string, string>;
  /** Tools that leave the catalog (a retirement, or the sources of a crafted merge). */
  hide: string[];
  add: AddedTool[];
  /** Consecutive calls inside this set become one call (merge, combine, fold, enrich, parallel, prerequisite). */
  collapse: string[];
  /** A failed call to one of these is not retried: the retries drop (fail clearly, tighten a schema). */
  dedupeRetries: string[];
  /** Every list is cut to this many results (return fewer results). */
  topK: number | null;
  /** A skill hands these steps over: the searches made to reach them drop. */
  skillSteps: string[];
  /** Why nothing can be simulated, in plain words; null when something can. */
  unsupportedReason: string | null;
  /**
   * RC-61: what a model replay applies (absent on sets made before it). The
   * crafted definitions offered to the model, the tool whose failures become
   * clear, a prerequisite to state, a skill to hand over.
   */
  replay?: ReplayChange;
}

/** A tool definition as the model is offered it. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema of the arguments. */
  parameters: Record<string, unknown>;
}

/** A crafted definition, and the tools it stands in for (empty when it only changes itself). */
export interface CraftedToolDef extends ToolDef {
  replaces: string[];
}

export interface ReplayChange {
  /** Crafted definitions: new tools (with `replaces`) or a tool's new schema (same name, no `replaces`). */
  tools: CraftedToolDef[];
  /** Tools whose failures come back as a clear failure. */
  failClearly: string[];
  /** "Run `before` first, then `tool`": said on `tool`'s description. */
  prerequisite: { before: string; tool: string } | null;
  /** A skill: its name, the steps in order, handed to the model. */
  skill: { name: string; steps: string[] } | null;
}

/* - How a run was simulated (RC-61) ----------------------------------------- */

export const SIM_METHODS = ["rerank", "replay", "none"] as const;
/** `rerank`: the run's ask ranked again (deterministic); `replay`: the model replayed the run; `none`: can't simulate. */
export type SimMethod = (typeof SIM_METHODS)[number];

export const SIM_METHOD_LABELS: Record<SimMethod, string> = {
  rerank: "Search re-ranked",
  replay: "Model replay",
  none: "Can't simulate",
};

/** A run's part in the eval: graded (holdout) or the insight's own evidence (shown apart, not counted). */
export type CaseRole = "holdout" | "evidence";

/** Whether the change moves rankings (and so needs the catalog and the searches' text). */
export function changesRanking(change: FixChange): boolean {
  return Object.keys(change.patches).length > 0 || change.add.length > 0 || change.hide.length > 0;
}

/* - A historical run, as the simulator reads it ----------------------------- */

export interface SearchStep {
  kind: "search";
  ordinal: number;
  /**
   * RC-77: the wire type. A `skill_search` ranks skills, not tools, so the
   * right-tool check never reads it. Absent on runs built before it was read
   * (and in fixtures): a tool search.
   */
  searchType?: string | null;
  /** The ask's text, read live from the event; null once the event is pruned. Never stored. */
  query: string | null;
  /** The list the agent was served, in rank order (up to 32); null when none was recorded. */
  hitIds: string[] | null;
  topK: number | null;
}

export interface InvokeStep {
  kind: "invoke";
  ordinal: number;
  targetId: string;
  outcome: "ok" | "error" | "unknown";
}

export type RunStep = SearchStep | InvokeStep;

export interface RunRecord {
  /** `trace_turns.id`. */
  turnId: string;
  traceId: string | null;
  startedAt: string;
  /** The task (Agent health workflow id), when the run belongs to one. */
  taskId: string | null;
  steps: RunStep[];
  /** RC-61: when its last step happened, and every trace it touched (its model calls are found through them). */
  endedAt?: string;
  traceIds?: string[];
  /** RC-61: how long the run took, first step to last (ms); null when unknown. */
  durationMs?: number | null;
  /** RC-61: what its model calls cost (sum of the recorded LLM calls); null when none was recorded. */
  costUsd?: number | null;
  /** RC-61: whether its last model call ended in an answer (finish reason `stop`); null when unknown. */
  answered?: boolean | null;
}

/* - What a run should do ---------------------------------------------------- */

/**
 * The expected outcome of one run once the fix is made, as checks. Null or
 * empty turns a check off. Editable per run on the eval page.
 */
export interface Expected {
  /** The tool that should be in the first list the agent sees. */
  tool: string | null;
  maxToolCalls: number | null;
  maxSearches: number | null;
  maxFailedCalls: number | null;
  /** Tools the run should not call (or be offered first). */
  avoidTools: string[];
  /*
   * RC-61 outcome checks: what the fix doesn't change directly. Absent (null)
   * on runs added before them, which turns them off.
   */
  /** The run ends well: it ran a tool or answered, and didn't end on a failed call. */
  endsWell?: boolean | null;
  /** Retries, switches and give-ups after a failed call (Self-corrections' own definition). */
  maxSelfCorrections?: number | null;
  /** What the run's model calls may cost, in dollars. */
  maxCostUsd?: number | null;
  /** How long the run may take, in milliseconds. */
  maxLatencyMs?: number | null;
}

export const NO_EXPECTATION: Expected = {
  tool: null,
  maxToolCalls: null,
  maxSearches: null,
  maxFailedCalls: null,
  avoidTools: [],
  endsWell: null,
  maxSelfCorrections: null,
  maxCostUsd: null,
  maxLatencyMs: null,
};

export const CHECK_KINDS = [
  "right_tool",
  "max_tool_calls",
  "max_searches",
  "max_failed_calls",
  "avoid_tools",
  "ends_well",
  "max_self_corrections",
  "max_cost",
  "max_latency",
  "criteria",
  "does_the_work",
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/** `target`: what the fix aims at; `outcome`: how the run ended, which the fix doesn't set; `criteria`: the person's words, judged. */
export type CheckGroup = "target" | "outcome" | "criteria";

export const CHECK_GROUP: Record<CheckKind, CheckGroup> = {
  right_tool: "target",
  max_tool_calls: "target",
  max_searches: "target",
  max_failed_calls: "target",
  avoid_tools: "target",
  ends_well: "outcome",
  max_self_corrections: "outcome",
  max_cost: "outcome",
  max_latency: "outcome",
  criteria: "criteria",
  does_the_work: "outcome",
};

/** Each check in plain words, for the eval page. */
export const CHECK_LABELS: Record<CheckKind, string> = {
  right_tool: "Right tool in the first list",
  max_tool_calls: "Tool calls",
  max_searches: "Searches",
  max_failed_calls: "Failed calls",
  avoid_tools: "Avoids tools",
  ends_well: SCORER_LABELS.ends_well,
  max_self_corrections: "Self-corrections",
  max_cost: "Model cost",
  max_latency: "Time taken",
  criteria: "Criteria",
  does_the_work: "Does what the run did",
};

export const CASE_ORIGINS = ["issue", "tool", "task", "manual"] as const;
export type CaseOrigin = (typeof CASE_ORIGINS)[number];

export const CASE_ORIGIN_LABELS: Record<CaseOrigin, string> = {
  issue: "From the issue",
  tool: "Ran the tool",
  task: "Task run",
  manual: "Added by you",
};

export interface EvalCase {
  id: string;
  turnId: string;
  traceId: string | null;
  origin: CaseOrigin;
  originRef: string | null;
  expected: Expected;
  outcome: string;
  criteria: string;
  position: number;
}

/* - What the simulation found ----------------------------------------------- */

/**
 * One side of a run (as recorded, or with the fix applied) in the numbers the
 * checks read. A number a side can't know is null (RC-61): the re-rank's after
 * side knows its first list and nothing it would have called; a replay knows
 * its calls and not the search list the harness would have served.
 */
export interface RunView extends ReplayWork {
  /** The first list the agent saw, cut to the window it was shown. Null when the run made no search. */
  firstList: string[] | null;
  /** False when this side can't know its first list (a replay: searches are the harness's). Absent means true. */
  listKnown?: boolean;
  searches: number | null;
  /** Tool calls in order (target ids); null when this side can't know them. */
  calls: string[] | null;
  /** Each call's outcome, parallel to `calls`. Absent: unknown outcomes (only `failed` is known). */
  outcomes?: ("ok" | "error" | "unknown")[] | null;
  failed: number | null;
  /** Whether the run ended in an answer (a replay's final message, a recorded `stop`); null when unknown. */
  answered?: boolean | null;
  costUsd?: number | null;
  latencyMs?: number | null;
}

export interface CheckResult {
  kind: CheckKind;
  pass: boolean;
  /** 0..1: the rank credit for `right_tool`, else 1 or 0. */
  score: number;
  /** The reading, in a few words: "rank 3", "4 calls", "not in the list". */
  detail: string;
  /** RC-61; absent on older results, which read as `target`. */
  group?: CheckGroup;
  /** False when either side couldn't measure it: shown, never scored. Absent means measured. */
  measured?: boolean;
}

export interface SideResult {
  pass: boolean;
  score: number;
  checks: CheckResult[];
  /** Counts for the table. */
  rank: number | null;
  calls: number | null;
  searches: number | null;
  failed: number | null;
}

export const SKIP_REASONS = [
  "run-gone",
  "query-expired",
  "no-checks",
  "not-affected",
  "cant-simulate",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  "run-gone": "The run is no longer stored",
  "query-expired": "The ask's text has expired (kept 30 days)",
  "no-checks": "No expected outcome set",
  "not-affected": "Nothing the fix changes",
  "cant-simulate": "Can't simulate this run",
};

/** One run's simulation. Stored; never carries the ask's text. */
export interface CaseResult {
  caseId: string;
  turnId: string;
  simulated: boolean;
  skipped: SkipReason | null;
  before: SideResult | null;
  after: SideResult | null;
  /** RC-61. Absent on older results (read as holdout, re-ranked or transformed). */
  role?: CaseRole;
  method?: SimMethod;
  /** Why it can't be simulated, or what the replay had to stand in for, in plain words. */
  methodNote?: string | null;
  /** A replay: tool results answered by a stand-in, and whether the replay without the fix took the recorded path. */
  replay?: ReplayFacts | null;
  /** RC-69: replayed, but the side without the fix made no tool calls where the run made some (RC-76: or took another path). Not scored; counts against fidelity. */
  replayFailed?: boolean;
}

export interface ReplayFacts {
  model: string;
  /** The model the run recorded, when the replay had to use another. */
  recordedModel: string | null;
  steps: { before: number; after: number };
  standIns: { before: number; after: number };
  /** The replay without the fix called the same tools in the same order as the recording. */
  controlMatchesRecording: boolean;
  /**
   * Tool ids called on each side, in order (names only, never arguments or
   * text). RC-76 `intended`: the recorded path as the fix would run it (a
   * merge's sources in a row become the merged tool); only for a merge.
   */
  paths: { recorded: string[]; before: string[]; after: string[]; intended?: string[] };
  /** A side stopped at the step cap. */
  capped: boolean;
  /** RC-76: how each side ended; absent on older results. `not-run`: the side with the fix wasn't replayed (no baseline). */
  stops?: { before: ReplayStop; after: ReplayStop };
}

export const REPLAY_STOPS = ["answered", "step-cap", "not-run"] as const;
export type ReplayStop = (typeof REPLAY_STOPS)[number];

export interface Tally {
  passed: number;
  total: number;
  /** 0..1, null when nothing was simulated. */
  passRate: number | null;
  /** Mean run score, 0..1. */
  score: number | null;
}

/** `unreliable` (RC-69): the replay without the fix took the recorded path too rarely for its numbers to mean anything. */
export const VERDICTS = [
  "better",
  "same",
  "worse",
  "too-few",
  "unsupported",
  "unreliable",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface SimulationSummary {
  before: Tally;
  after: Tally;
  /** 95% paired-bootstrap interval on the mean score change. */
  interval: { low: number; high: number } | null;
  verdict: Verdict;
  nCases: number;
  nSimulated: number;
  /** RC-61: the insight's own runs, scored apart and not counted in the verdict. */
  evidence?: { before: Tally; after: Tally; nSimulated: number } | null;
  /** RC-61: graded runs by group of check. */
  breakdown?: {
    target: { before: Tally; after: Tally };
    outcome: { before: Tally; after: Tally };
    criteria: { before: Tally; after: Tally };
  } | null;
  /** RC-61: graded runs by method, and why the rest couldn't be simulated. */
  methods?: MethodTally | null;
}

export interface MethodTally {
  rerank: number;
  replay: number;
  none: number;
  /** The most common reasons a run couldn't be simulated, with counts. */
  reasons: { note: string; runs: number }[];
  /** Replays whose run without the fix took the recorded path, of all replays. */
  fidelity: { matched: number; total: number } | null;
}

/** RC-61: what the models cost one simulation, and whether the criteria were judged. */
export interface ModelSpend {
  usd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** The cap it ran under. */
  capUsd: number;
  /** True when the cap stopped it before every run was done. */
  capped: boolean;
  models: string[];
}

export type JudgeStatus =
  | { status: "judged"; model: string; runs: number }
  | { status: "not-configured" }
  | { status: "no-criteria" }
  | { status: "budget"; model: string; runs: number; skipped: number }
  | { status: "stand-in"; model: string; runs: number };

/* - What the rest of the console reads -------------------------------------- */

export const RUN_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type EvalRunStatus = (typeof RUN_STATUSES)[number];

/** The badge on a fix: before → after on N runs, or that it was never simulated. */
export type EvalBadge =
  | { state: "none" }
  | { state: "pending"; runs: number }
  | { state: "failed"; runs: number }
  | {
      state: "done";
      verdict: Verdict;
      before: Tally;
      after: Tally;
      /** Runs simulated (the N in "Simulated on N historical runs"). */
      runs: number;
      finishedAt: string | null;
      /** True when the set changed after this simulation. */
      stale: boolean;
      /** RC-61: how the runs were simulated; absent on older simulations. */
      method?: SimMethod | "mixed";
    };

/** What `runSimulation` returns (RC-43's `run_eval` hands it to MCP as is). */
export interface SimulationOutcome {
  fixId: string;
  projectId: string;
  setId: string;
  runId: string;
  status: EvalRunStatus;
  /** "Simulated on 24 historical runs". */
  label: string;
  nCases: number;
  nSimulated: number;
  before: Tally | null;
  after: Tally | null;
  verdict: Verdict | null;
  /** The eval page. */
  href: string;
  /** The insight the fix came from (one step back), when it has one. */
  source: LineageRef | null;
  /** The fix and the eval itself, as lineage refs. */
  fix: LineageRef;
  eval: LineageRef;
  error: string | null;
  /** RC-61 (additive): the insight's own runs, apart; runs by method; model spend. */
  evidence?: SimulationSummary["evidence"];
  methods?: MethodTally | null;
  spend?: ModelSpend | null;
}
