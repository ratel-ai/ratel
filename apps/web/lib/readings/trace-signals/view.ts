import type { PlanLimits } from "@/lib/platform/entitlements";
import { formatSharePercent } from "@/lib/readings/trace-signals/claims";
import type { DismissedSignal } from "@/lib/readings/trace-signals/dismiss";
import type { StoredSetup } from "@/lib/readings/trace-signals/setup-facts";
import type { WorkflowsView } from "@/lib/readings/trace-signals/view-workflows";

/**
 * The Agent health view model: the one contract between the trace-signals engine
 * and the page.
 *
 * Everything here is display-ready and serializable. The engine (lane A2) builds
 * it from `trace_turns` and `trace_signals`; until then `mock-fixture.ts` holds a
 * hand-written instance so the UI lanes can build against the same shape. No raw
 * event rows, no JSON blobs, no formulas: the page renders sentences, figures and
 * pictures, and anything a component would need to compute belongs in a builder
 * here instead.
 *
 * Shares are fractions in [0, 1]. Timestamps are ISO strings so the model crosses
 * the server/client boundary untouched.
 */

/* - Vocabulary -------------------------------------------------------------- */

/**
 * How much of each turn the project sends. `events` is runtime events with no
 * tool detail, `tools` adds tool ids and outcomes, `content` adds the captured
 * conversation (queries, arguments) that four signals need.
 */
export type CaptureLevel = "events" | "tools" | "content";

/**
 * Who decided a figure. `deterministic` is counted from traces; `classifier` is
 * a classifier tier, not yet used; `judge` is a model verdict. Never blended: each tier
 * renders under its own glyph.
 */
export type SignalTier = "deterministic" | "classifier" | "judge";

/** Every signal the catalog can emit. Mirrors the plan's catalog table one to one. */
export const SIGNAL_KINDS = [
  "first_try_miss",
  "buried_tool",
  "magnet",
  "dead_tool",
  "sequence_chain",
  "sibling_confusion",
  "error_loop",
  "no_follow_through",
  "abandoned_search",
  "padding_share",
  "latency_outlier",
  "unstable_intent",
  "repeat_invoke",
  "fragmented_intents",
  "cooccurring_intents",
  // Read from OpenTelemetry (tool spans, model round trips, tool menus), not from searches.
  "tool_switch",
  "empty_result",
  "unknown_tool",
  "unused_tool",
  "long_turn",
  "blocked_action",
  "identical_retry",
  "wait_heavy",
  "token_heavy",
  "system_turn_failing",
  "agent_failing",
  // Read from workflows: the recurring groups of tools one request runs (`workflows/`).
  "workflow_failing",
  "workflow_slow",
  "workflow_fixed_chain",
  // Read from self-corrections (`self-corrections/`): a tool or a task the agent often corrects itself after.
  "self_correcting",
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

/**
 * What a signal is about. `tool_pair` covers both ordered chains and sibling
 * pairs; `workflow` is a mined workflow, keyed by its stable id.
 */
export type SignalSubjectKind =
  | "tool"
  | "skill"
  | "tool_pair"
  | "query_cluster"
  | "project"
  | "source"
  | "workflow";

/** Lifecycle of a stored signal. Runs never touch `fixed` or `muted`. */
export type SignalStatus = "open" | "acknowledged" | "resolved" | "fixed" | "muted";

/**
 * The fix named in words on each card. The cards have no buttons yet; a later release
 * wires each route to a fixer behind "Fix this".
 */
export type SignalFixRoute =
  | "rewrite_description"
  | "adaptive_ranking"
  | "retire_tool"
  | "workflow_skill"
  | "disambiguate_pair"
  | "lower_top_k"
  | "show_turns"
  | "run_extraction"
  | "none";

/** How a turn's boundaries were found. Inferred turns get a caveat on the card. */
export type TurnSource = "declared" | "inferred" | "otlp";

/**
 * Where a project's turns come from: the Ratel SDK (runtime events, with a
 * search step), OpenTelemetry only (tool spans, no search), or both. Read
 * from the latest run's turn counts by source (`sourceModeOf`).
 */
export type SourceMode = "sdk" | "otel" | "mixed";

/** Turn counts by boundary source, so the UI can say "boundaries inferred from timing". */
export interface TurnSourceMix {
  declared: number;
  inferred: number;
  otlp: number;
}

/** A two-sided confidence interval (a Wilson bound for shares), same unit as its value. */
export interface Interval {
  low: number;
  high: number;
}

/* - Window ------------------------------------------------------------------ */

export const WINDOW_DAY_OPTIONS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOW_DAY_OPTIONS)[number];

/** "This week": the window every plan can read and the page opens on. */
export const DEFAULT_WINDOW_DAYS: WindowDays = 7;

/** Turns needed before the band and signals render instead of the collecting meter. */
export const FIRST_READING_FLOOR = 50;

/* - Health band ------------------------------------------------------------- */

/**
 * The SDK band reads first try, detours, junk and wasted calls. A project that
 * only sends OpenTelemetry has no search to score, so its band reads
 * completed runs, failed calls, wasted calls and model round trips instead.
 */
export type HealthTileKey =
  | "first_try"
  | "detours"
  | "junk"
  | "wasted_calls"
  | "completed"
  | "failed_calls"
  | "round_trips"
  | "cost_per_run"
  | "model_calls";

/** One day of a tile's trailing series. `value` is null for a day with no turns. */
export interface TilePoint {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  value: number | null;
}

export interface HealthTile {
  key: HealthTileKey;
  /** Plain label, e.g. "First try". Changes for `junk` when the classifier tier is on. */
  label: string;
  /** Headline figure in `unit`; null while collecting (the tile renders a dash). */
  value: number | null;
  /** `share` renders as a whole percent; `per_100_turns` and `per_turn` as one-decimal rates; `usd` as dollars. */
  unit: "share" | "per_100_turns" | "per_turn" | "usd";
  /** Interval around `value`, printed in mono under the figure. Null when not computed. */
  interval: Interval | null;
  /** One plain sentence under the figure, e.g. "822 of 1,284 turns found the tool first". */
  sub: string;
  tier: SignalTier;
  /** Whether a rising value is good news; drives the delta chip colour. */
  upIsGood: boolean;
  /** Change against the previous window of the same length, in `unit`. Null without one. */
  delta: number | null;
  /** Trailing daily series, oldest first, for the sparkline. */
  series: readonly TilePoint[];
  /** Turns (or, for `junk`, listed hits) behind the figure. */
  n: number;
}

/* - Flow map ---------------------------------------------------------------- */

/**
 * The tint of a node or edge. `magnet` coral, `buried` amber, `dead` muted and
 * dashed, `healthy` green, `none` for tools with nothing to say.
 */
export type FlowTint = "magnet" | "buried" | "dead" | "healthy" | "none";

/**
 * `search` is the single source node every turn starts from; `quiet` is the one
 * plate that folds every tool below the top of the map ("and 53 quiet tools").
 */
export type FlowNodeKind = "search" | "tool" | "skill" | "quiet";

export interface FlowNode {
  /** Tool or skill id; `search` and `quiet` for the two synthetic nodes. */
  id: string;
  kind: FlowNodeKind;
  label: string;
  /** Invocations in the window; sizes the plate. */
  invocations: number;
  /** Times the tool was listed in a search result; 0 for synthetic nodes. */
  impressions: number;
  tint: FlowTint;
  /** Ids of the signals this node is the subject of; a click opens the first. */
  signalIds: readonly string[];
  /** For the `quiet` plate only: how many tools it folds. */
  quietCount?: number;
}

/**
 * `pick` runs from search to the tool it led to, `sequence` from a tool to the one
 * that followed it in the same turn, `sibling` joins two tools picked
 * interchangeably (undirected; `from`/`to` are in id order).
 */
export type FlowEdgeKind = "pick" | "sequence" | "sibling";

export interface FlowEdge {
  from: string;
  to: string;
  kind: FlowEdgeKind;
  /** Turns that took this edge; drives the stroke width. */
  count: number;
  /** In [0, 1]; drives the stroke opacity. */
  confidence: number;
  tint: FlowTint;
  signalIds: readonly string[];
}

/**
 * How a journey starts: with a search before the first call, or without one.
 * A turn from OpenTelemetry has no search step to miss: it starts at `agent`.
 */
export type FlowJourneyStart = "search" | "none" | "agent";

/** One way a turn went, call by call, and how many turns went that way. */
export interface FlowJourneyPath {
  start: FlowJourneyStart;
  /** Node ids of the first calls, in order; {@link FLOW_JOURNEY_OTHER} for a folded tool. */
  tools: readonly string[];
  /** `ended`: no more calls; `more`: the turn went on past the last recorded call. */
  end: "ended" | "more";
  turns: number;
}

/** An open problem a journey node flags with an icon: calls that fail, calls that are slow. */
export type FlowJourneyFlag = "errors" | "slow";

/** A tool a journey names, with the flow's tint, signals and problem flags for it. */
export interface FlowJourneyTool {
  id: string;
  kind: "tool" | "skill" | "other";
  label: string;
  tint: FlowTint;
  signalIds: readonly string[];
  flags: readonly FlowJourneyFlag[];
}

/** One "needs first" pair a run counted call by call (`flow.prerequisites`). */
export interface FlowPrerequisitePair {
  /** Node ids: the tool that ran first, and the tool that needed it. */
  first: string;
  tool: string;
  /** Calls of `tool`. */
  uses: number;
  /** Of those, calls with `first` earlier in the same session, within the window. */
  window: number;
  /** Of those, calls with `first` earlier in the same turn. */
  turn: number;
  windowLift: number;
  turnLift: number;
}

/** The pairs a run counted across sessions; absent on runs stored before it (the map reads pairs off the paths). */
export interface FlowPrerequisites {
  /** How far back a call looked, in ms. */
  windowMs: number;
  pairs: readonly FlowPrerequisitePair[];
}

/**
 * The journey view of the flow: every turn as a path of positions (how it
 * started, 1st call, 2nd call, ...). Absent on runs stored before it existed;
 * the map then falls back to the older search-to-tool drawing.
 */
export interface FlowJourney {
  /** Call positions each path records. */
  steps: number;
  turns: number;
  paths: readonly FlowJourneyPath[];
  tools: readonly FlowJourneyTool[];
  /** Per position (index 0 is the 1st call): distinct tools folded into "other". */
  otherTools: readonly number[];
  /** Open signals about searching itself (padding, abandoned searches). */
  searchSignalIds: readonly string[];
  /** What each tool needs first, counted across sessions. Its tools are in `tools` too. */
  prerequisites?: FlowPrerequisites;
}

/** The id of the folded "other tools" in a journey. */
export const FLOW_JOURNEY_OTHER = "~other";

export interface FlowModel {
  nodes: readonly FlowNode[];
  edges: readonly FlowEdge[];
  /** Tools in the catalog, including the ones folded into the quiet plate. */
  totalTools: number;
  /** Turns call by call; absent on older runs. */
  journey?: FlowJourney;
}

/* - Turn shapes ------------------------------------------------------------- */

/**
 * The six shapes a turn can take: `direct` search then the right tool, `detour`
 * searched again first, `dead_end` searched and ran nothing, `retry` ran, failed,
 * ran again, `blind` ran a tool with no search, `repeat` ran the same tool again.
 */
export const TURN_SHAPE_KINDS = [
  "direct",
  "detour",
  "dead_end",
  "retry",
  "blind",
  "repeat",
] as const;

export type TurnShapeKind = (typeof TURN_SHAPE_KINDS)[number];

/**
 * The shapes of a turn read from OpenTelemetry, where no search step exists
 * and "blind" would be wrong: `otel_direct` one call, `otel_chain` two or more
 * calls that all worked, `otel_retry` a failed call run again,
 * `otel_switched` a failed call and then a different tool, `otel_failed` the
 * last call failed. The last three are self-corrections after an error
 * (`self-corrections/detect.ts`). Prefixed so they never collide with the
 * SDK's `direct` and `retry`.
 */
export const OTEL_TURN_SHAPE_KINDS = [
  "otel_direct",
  "otel_chain",
  "otel_retry",
  "otel_switched",
  "otel_failed",
] as const;

export type OtelTurnShapeKind = (typeof OTEL_TURN_SHAPE_KINDS)[number];

/** Any shape the page can draw: the SDK six or the OpenTelemetry five. */
export type AnyTurnShapeKind = TurnShapeKind | OtelTurnShapeKind;

export interface TurnShapeView {
  shape: AnyTurnShapeKind;
  /** "Direct", "Detour", "Dead end", "Retry", "Blind", "Repeat"; for OpenTelemetry "Direct", "Chain", "Retry", "Switched", "Failed". */
  label: string;
  /** One plain sentence describing the shape. */
  description: string;
  /** Share of the window's turns, in [0, 1]. */
  share: number;
  count: number;
}

/* - Signals ----------------------------------------------------------------- */

/** A catalog entry named inside a claim, rendered as an inline chip. */
export interface SubjectChip {
  id: string;
  label: string;
  entryKind: "tool" | "skill";
}

export interface SignalSubject {
  kind: SignalSubjectKind;
  /** Stable key: tool id, `a>b` for chains, `a|b` for pairs, a hash, or `project`. */
  key: string;
  /** Short plain label for the subject as a whole, e.g. "find_task then assign_task". */
  label: string;
  /** The catalog entries the claim names, in claim order. Empty for project-level signals. */
  chips: readonly SubjectChip[];
}

/**
 * The claim sentence in pieces so the UI can swap subject names for chips. The
 * `text` of every segment, joined, equals `SignalView.claim`.
 */
export type ClaimSegment =
  | { kind: "text"; text: string }
  | { kind: "subject"; text: string; chipId: string };

/** The big number on the right of a collapsed card. */
export interface SignalFigure {
  value: number;
  unit: "share" | "count" | "ms" | "rank";
  /** Pre-formatted headline: "41%", "23", "12.4 s", "#7". */
  display: string;
  /** The raw count in mono beneath it: "509 lists · 3 picks". */
  raw: string;
  /**
   * A tiny unit under the headline, e.g. "weak results". Optional: absent, the
   * row uses its kind's default (`SIGNAL_FIGURE_CAPTIONS`); set only where one
   * kind's figure measures different things.
   */
  caption?: string;
}

/** A query as the story can show it. Pruned events read `expired`, never blank. */
export type StoryQuery =
  | { state: "captured"; text: string }
  | { state: "not_captured" }
  | { state: "expired" };

/** Marks the step the signal is about; the UI rings it coral and prints `label`. */
export interface StoryFlag {
  label: string;
}

/**
 * One step of a sampled turn, told as a story: `searched "..."`, `listed 10`,
 * `picked #7 assign_task`, `ran link_pr_to_task`, `error`.
 */
export type TurnStoryStep =
  | {
      kind: "search";
      query: StoryQuery;
      /** How many hits the search listed. */
      listed: number;
      flag?: StoryFlag;
      /** The step's `trace_events` row, so Traces can point at it; absent in fixtures. */
      eventId?: string;
    }
  | {
      kind: "invoke";
      toolId: string;
      /** Rank the tool held in the search that offered it; null when it was not offered. */
      pickedRank: number | null;
      outcome: "ok" | "error" | "unknown";
      /** Duration, when the invocation recorded one. */
      tookMs: number | null;
      flag?: StoryFlag;
      /** The step's `trace_events` row (the call's start), so Traces can point at it. */
      eventId?: string;
    };

/** A sampled turn behind a signal. */
export interface EvidenceTurn {
  turnId: string;
  /** Trace to open for the real waterfall; null when the turn has none. */
  traceId: string | null;
  startedAt: string;
  turnSource: TurnSource;
  steps: readonly TurnStoryStep[];
}

/** The small chart in an expanded card. */
export type EvidenceChart =
  | { kind: "rank_histogram"; bands: readonly { label: string; count: number }[] }
  | { kind: "sparkline"; points: readonly TilePoint[] };

export interface SignalEvidence {
  chart: EvidenceChart | null;
  /** Sampled turns, already cut to the plan's `agentHealthEvidenceTurns`. */
  turns: readonly EvidenceTurn[];
  /** Turns that support the signal in total, of which `turns` is a sample. */
  totalTurns: number;
}

export interface SignalView {
  /** Stable id (the `trace_signals` row id); cards and flow nodes link by it. */
  id: string;
  kind: SignalKind;
  tier: SignalTier;
  status: SignalStatus;
  subject: SignalSubject;
  /** The plain claim, e.g. "create_task rides into 41% of lists and is picked in 1%." */
  claim: string;
  claimSegments: readonly ClaimSegment[];
  figure: SignalFigure;
  /** Ranking key in [0, 1]: the Wilson bound the detector fired on. */
  severity: number;
  /** Waste count: turns times extra units. The list sorts on severity then this. */
  impact: number;
  /** The cost line in the expanded card, e.g. "About 140 extra searches this window." */
  cost: string;
  /** Observations behind the figure. */
  n: number;
  interval: Interval | null;
  /** The "What to do" line. */
  fix: string;
  fixRoute: SignalFixRoute;
  /** One caveat band in the expanded card, or null. */
  caveat: string | null;
  turnSourceMix: TurnSourceMix;
  evidence: SignalEvidence;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** A signal kind the project would get with content capture on, shown as a ghost row. */
export interface CaptureUnlock {
  key: string;
  label: string;
  description: string;
}

/* - Workflows --------------------------------------------------------------- */

export type {
  UnservedAskView,
  WorkflowExampleView,
  WorkflowModelView,
  WorkflowProblemView,
  WorkflowRowView,
  WorkflowStepView,
  WorkflowsView,
  WorkflowToolView,
} from "@/lib/readings/trace-signals/view-workflows";

/* - Page -------------------------------------------------------------------- */

export interface HealthPageModel {
  windowDays: WindowDays;
  /** Closed turns in the window. */
  turns: number;
  /**
   * With no runs yet: data that arrives but can never make one. `tool_spans`:
   * OpenTelemetry model calls arrive without a single tool span. Absent otherwise.
   */
  waitingOn?: "tool_spans";
  /** Turns needed for a first reading; below it the page shows the collecting meter. */
  floor: number;
  captureLevel: CaptureLevel;
  turnSourceMix: TurnSourceMix;
  /**
   * Where the turns come from. `otel` swaps the search tiles and shapes for
   * ones OpenTelemetry can measure; `mixed` keeps the SDK page with a badge.
   */
  sourceMode: SourceMode;
  /**
   * The band in order: first try, detours, junk, wasted calls; for `otel`,
   * completed, failed calls, wasted calls and (when model calls were sent)
   * round trips. When SDK runs are linked to OpenTelemetry model calls:
   * first try, wasted calls, cost per run and model calls per run.
   */
  tiles: readonly HealthTile[];
  flow: FlowModel;
  /** Six shapes (five for `otel`), sorted by share descending. */
  shapes: readonly TurnShapeView[];
  /** Signals above their floor, worst first, already cut to the plan. */
  signals: readonly SignalView[];
  /** Signals seen but not yet confident, shown under "Too early to call". */
  tooEarly: readonly SignalView[];
  /** Signals cut by the plan, for the "+N more signals on Plus" panel. */
  lockedCount: number;
  /** Slow-tool problems a person hid as slow by design, for the "Show again" line. Absent on fixtures. */
  dismissed?: readonly DismissedSignal[];
  /** Evidence turns each card may show on this plan; 0 means the drawer is an upsell. */
  evidenceTurnsPerSignal: number;
  /** What content capture would add; empty when `captureLevel` is `content`. */
  captureUnlocks: readonly CaptureUnlock[];
  /**
   * What the project sends, data point by data point (`summary.setup` of the
   * latest run), for the setup card. Null or absent on runs stored before it:
   * the page then falls back to the capture nudge.
   */
  setup?: StoredSetup | null;
  /** When the signals were last computed; null before the first run. */
  computedAt: string | null;
  /**
   * Days of evidence behind the signal list and the flow map: the latest run's
   * window, cut to the days since the project's first turn. Both come from that
   * one run and do not move with the 7d/30d/90d control (the band and shapes
   * do), so the page labels them with this span whenever it differs from
   * `windowDays` (see {@link runWindowLabel}). Null before the first run.
   */
  signalWindowDays: number | null;
  /**
   * The workflows the latest run found (`workflows-view.ts`); null when the
   * run stored none (runs from before workflows, or with no tool calls), and
   * the section is not drawn.
   */
  workflows: WorkflowsView | null;
  /**
   * Turn events the reading's run could not read because they were still
   * being built when it started (`summary.unbuiltAtStart`), set only when
   * enough to change the numbers: the page asks for another reading. Absent
   * on a complete reading and before the first run.
   */
  unbuiltAtReading?: number;
}

/** The header's words for a window: "this week", "in the last 30 days". */
export function windowPhrase(days: number): string {
  if (days === 7) return "this week";
  if (days === 1) return "in the last day";
  return `in the last ${days} days`;
}

/**
 * The label the signal list and flow map carry when their run's evidence span
 * differs from the selected window, e.g. "last 22 days"; null when they agree
 * or before the first run.
 */
export function runWindowLabel(
  model: Pick<HealthPageModel, "windowDays" | "signalWindowDays">,
): string | null {
  const days = model.signalWindowDays;
  if (days === null || days <= 0 || days === model.windowDays) return null;
  return days === 1 ? "last day" : `last ${days} days`;
}

export type HealthReadiness = "no_telemetry" | "collecting" | "ready";

/** Which of the three page states to render. */
export function healthReadiness(model: Pick<HealthPageModel, "turns" | "floor">): HealthReadiness {
  if (model.turns <= 0) return "no_telemetry";
  if (model.turns < model.floor) return "collecting";
  return "ready";
}

/* - Plan slicing ------------------------------------------------------------ */

export type AgentHealthPlanLimits = Pick<
  PlanLimits,
  "agentHealthSignalsShown" | "agentHealthEvidenceTurns" | "agentHealthWindowDays"
>;

/** Keeps the first `shown` signals (the list is worst first) and counts the rest. */
export function sliceSignalsForPlan(
  signals: readonly SignalView[],
  shown: number,
): { shown: readonly SignalView[]; lockedCount: number } {
  const limit = Number.isFinite(shown) ? Math.max(0, Math.floor(shown)) : signals.length;
  const kept = signals.slice(0, limit);
  return { shown: kept, lockedCount: signals.length - kept.length };
}

/** Cuts every signal's sampled turns to the plan's allowance. */
export function sliceEvidenceForPlan(
  signals: readonly SignalView[],
  turns: number,
): readonly SignalView[] {
  const limit = Number.isFinite(turns) ? Math.max(0, Math.floor(turns)) : Infinity;
  return signals.map((signal) =>
    signal.evidence.turns.length <= limit
      ? signal
      : {
          ...signal,
          evidence: { ...signal.evidence, turns: signal.evidence.turns.slice(0, limit) },
        },
  );
}

/**
 * Applies a plan to a full model: signals cut to `agentHealthSignalsShown` with
 * the remainder counted, evidence cut to `agentHealthEvidenceTurns`. The band,
 * map and shapes are never cut; free sees the whole picture.
 */
export function applyPlanLimits(
  model: HealthPageModel,
  limits: AgentHealthPlanLimits,
): HealthPageModel {
  const { shown, lockedCount } = sliceSignalsForPlan(model.signals, limits.agentHealthSignalsShown);
  const evidenceTurns = limits.agentHealthEvidenceTurns;
  const signals = sliceEvidenceForPlan(shown, evidenceTurns);
  const tooEarly = sliceEvidenceForPlan(model.tooEarly, evidenceTurns);
  // Kept finite so the model stays plain JSON; an unlimited plan reads as the
  // most any card actually carries.
  const perSignal = Number.isFinite(evidenceTurns)
    ? Math.max(0, Math.floor(evidenceTurns))
    : Math.max(0, ...[...signals, ...tooEarly].map((signal) => signal.evidence.turns.length));
  return {
    ...model,
    signals,
    tooEarly,
    lockedCount: model.lockedCount + lockedCount,
    evidenceTurnsPerSignal: perSignal,
  };
}

export interface WindowOption {
  days: WindowDays;
  label: string;
  /** True when the plan's `agentHealthWindowDays` is shorter than this window. */
  locked: boolean;
}

/** The 7d/30d/90d options with the ones past the plan's window locked. */
export function windowOptionsForPlan(maxDays: number): readonly WindowOption[] {
  return WINDOW_DAY_OPTIONS.map((days) => ({ days, label: `${days}d`, locked: days > maxDays }));
}

/**
 * Reads `?days=` against the plan. Anything that is not one of the three options
 * falls back to the default; a window the plan does not include falls back to the
 * longest one it does, so a pasted 90-day link still opens on something.
 */
export function parseWindowDays(
  raw: string | readonly string[] | undefined,
  maxDays: number,
): WindowDays {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  const requested = WINDOW_DAY_OPTIONS.find((days) => days === parsed) ?? DEFAULT_WINDOW_DAYS;
  if (requested <= maxDays) return requested;
  const allowed = WINDOW_DAY_OPTIONS.filter((days) => days <= maxDays);
  return allowed.at(-1) ?? DEFAULT_WINDOW_DAYS;
}

/* - Small readings ---------------------------------------------------------- */

const CAPTURE_LABEL: Record<CaptureLevel, string> = {
  events: "events only",
  tools: "tools only",
  content: "with content",
};

/** The header's evidence chip: "1,284 turns · tools only". */
export function evidenceChipText(model: Pick<HealthPageModel, "turns" | "captureLevel">): string {
  const turns = `${model.turns.toLocaleString("en-US")} ${model.turns === 1 ? "turn" : "turns"}`;
  return `${turns} · ${CAPTURE_LABEL[model.captureLevel]}`;
}

/** Whether the page has anything to list, for `health_viewed`. */
export function hasSignals(model: Pick<HealthPageModel, "signals" | "lockedCount">): boolean {
  return model.signals.length + model.lockedCount > 0;
}

/**
 * The one-line reading on the Continuous improvement index, e.g.
 * "First try 64% · 12 problems worth a look". Null until there is a reading.
 */
export function healthStripReading(model: HealthPageModel): string | null {
  if (healthReadiness(model) !== "ready") return null;
  const firstTry = model.tiles.find((tile) => tile.key === "first_try");
  const problems = model.signals.length + model.lockedCount;
  const parts = [
    ...(firstTry?.value != null ? [`First try ${formatSharePercent(firstTry.value)}`] : []),
    problems === 0
      ? "Nothing worth a look"
      : `${problems} ${problems === 1 ? "problem" : "problems"} worth a look`,
  ];
  return parts.join(" · ");
}

/** The Agent health route, optionally on a window. A top-level project page, right under Overview. */
export function agentHealthHref(projectId: string, days?: WindowDays): string {
  const root = `/project/${encodeURIComponent(projectId)}/health`;
  return days === undefined || days === DEFAULT_WINDOW_DAYS ? root : `${root}?days=${days}`;
}

/**
 * Where the old `/improvement/health` URL now sends a visitor: the new route
 * with every query parameter it came with, so a bookmarked window survives.
 */
export function agentHealthRedirectTarget(
  projectId: string,
  search: Readonly<Record<string, string | readonly string[] | undefined>> = {},
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string") query.append(key, value);
    else for (const item of value ?? []) query.append(key, item);
  }
  const root = `/project/${encodeURIComponent(projectId)}/health`;
  const text = query.toString();
  return text ? `${root}?${text}` : root;
}

/**
 * Where the Observability "Insights" teaser sends a visitor: Agent health once it
 * is on for the project, nowhere (the teaser renders) otherwise.
 */
export function insightsRedirectTarget(projectId: string, agentHealthOn: boolean): string | null {
  return agentHealthOn ? agentHealthHref(projectId) : null;
}

/**
 * One example turn in Traces: every call it made, in order, with the step the
 * signal is about highlighted and scrolled to. It works for every turn the
 * ledger kept (declared, inferred or OTLP, with or without a trace id), which
 * the trace waterfall cannot: runtime events rarely carry a trace.
 */
export function turnTracesHref(
  projectId: string,
  turnId: string,
  focusEventId?: string | null,
): string {
  const root = `/project/${encodeURIComponent(projectId)}/traces/turns/${encodeURIComponent(turnId)}`;
  if (!focusEventId) return root;
  const id = encodeURIComponent(focusEventId);
  return `${root}?focus=${id}#${turnEventAnchor(focusEventId)}`;
}

/** The in-page anchor of one call on the turn page. */
export function turnEventAnchor(eventId: string): string {
  return `event-${eventId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** The call an example is about: its flagged step, else none (the page opens at the top). */
export function exampleFocusEventId(turn: Pick<EvidenceTurn, "steps">): string | null {
  return turn.steps.find((step) => step.flag !== undefined)?.eventId ?? null;
}

/** The trace waterfall an evidence turn opens. */
export function evidenceTraceHref(projectId: string, traceId: string): string {
  return `/project/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}`;
}
