import type { TraceSignalRow } from "@/lib/readings/trace-signals/schema";
import { parseStoredSetup } from "@/lib/readings/trace-signals/setup-facts";
import type { RunSummary } from "@/lib/readings/trace-signals/signals/analyze";
import { flowView } from "@/lib/readings/trace-signals/signals/flow-model";
import {
  captureLevelOf,
  type DayBucket,
  emptyBucket,
  evidenceSpanDays,
  shapesFor,
  type TileWindow,
  tilesFor,
  totalOver,
  windowDays,
} from "@/lib/readings/trace-signals/signals/project-metrics";
import { signalKey } from "@/lib/readings/trace-signals/signals/types";
import type {
  CaptureLevel,
  CaptureUnlock,
  EvidenceTurn,
  HealthPageModel,
  HealthTile,
  SignalKind,
  SignalStatus,
  SignalSubjectKind,
  SignalTier,
  SignalView,
  SourceMode,
  TurnShapeView,
  TurnSourceMix,
  WindowDays,
} from "@/lib/readings/trace-signals/view";
import { FIRST_READING_FLOOR, SIGNAL_KINDS } from "@/lib/readings/trace-signals/view";
import type { WorkflowInsights } from "@/lib/readings/trace-signals/workflows/decide";
import type { WorkflowLabels } from "@/lib/readings/trace-signals/workflows/name";
import { claimModel, type SignalRecord } from "@/lib/views/health/signals/claims-model";
import { hasLinkedRuns, linkedTilesFor } from "@/lib/views/health/signals/linked-metrics";
import {
  otelCaptureLevel,
  otelCaptureUnlocks,
  otelShapesFor,
  otelTilesFor,
} from "@/lib/views/health/signals/otel-metrics";
import { mixOrFallback, sourceModeOf } from "@/lib/views/health/source-mode";
import { workflowsView } from "@/lib/views/health/workflows-view";

/**
 * Assembles the page's `HealthPageModel` from what the loader read: the latest
 * completed run (its summary holds the daily buckets and the flow), the open
 * signals, their evidence stories and the catalog's display names. Pure, so
 * the page's three states and the plan slicing are testable without a database.
 */

/** What content capture would add, shown as ghost rows by the capture nudge. */
export const CAPTURE_UNLOCKS: readonly CaptureUnlock[] = [
  {
    key: "cooccurring_intents",
    label: "Intents that travel together",
    description: "Asks that arrive in the same turn, drafted into one skill.",
  },
  {
    key: "detour_clusters",
    label: "Detour clusters",
    description: "The phrasings that send the agent on a second search.",
  },
  {
    key: "identical_repeats",
    label: "Identical repeat calls",
    description: "The same call with the same arguments, told apart from real follow-ups.",
  },
  {
    key: "classifier_junk",
    label: "Junk judged by a classifier",
    description: "Which listed hits could never have answered the ask.",
  },
];

const KINDS: ReadonlySet<string> = new Set(SIGNAL_KINDS);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function mixOf(value: unknown): TurnSourceMix {
  const m = asRecord(value);
  const n = (k: string) => (typeof m[k] === "number" ? (m[k] as number) : 0);
  return { declared: n("declared"), inferred: n("inferred"), otlp: n("otlp") };
}

/** A stored row as the claim builder reads it; null for a kind this build does not know. */
export function toSignalRecord(row: TraceSignalRow): SignalRecord | null {
  if (!KINDS.has(row.kind)) return null;
  const subject = asRecord(row.subject);
  const evidence = asRecord(row.evidence);
  return {
    id: row.id,
    kind: row.kind as SignalKind,
    status: row.status as SignalStatus,
    tier: row.tier as SignalTier,
    subjectKind: row.subjectKind as SignalSubjectKind,
    subjectKey: row.subjectKey,
    subjectIds: strings(subject.ids),
    entryKind: subject.entryKind === "skill" ? "skill" : "tool",
    severity: row.severity,
    impact: row.impact,
    n: row.n,
    metrics: asRecord(row.metrics),
    turnIds: strings(evidence.turnIds),
    traceEventIds: Array.isArray(evidence.traceEventIds)
      ? evidence.traceEventIds.map((v) => (typeof v === "string" ? v : null))
      : [],
    totalTurns: typeof evidence.totalTurns === "number" ? evidence.totalTurns : 0,
    turnSourceMix: mixOf(evidence.turnSourceMix),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

/** Parses a stored run summary; null when it is missing or from another version. */
export function parseRunSummary(value: unknown): RunSummary | null {
  const s = asRecord(value);
  if (s.version !== 1 || !Array.isArray(s.daily) || typeof s.coveredFrom !== "string") return null;
  const flow = asRecord(s.flow);
  if (!Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) return null;
  return value as RunSummary;
}

export interface CompletedRun {
  windowEnd: Date;
  windowDays: number;
  finishedAt: Date | null;
  summary: RunSummary;
  /** The run's turn counts by source (`trace_signal_runs.turn_source_mix`); absent falls back to the buckets'. */
  turnSourceMix?: TurnSourceMix;
}

export interface PageInputs {
  windowDays: WindowDays;
  run: CompletedRun | null;
  /** Closed turns in the page window when there is no run yet. */
  liveTurns: number;
  signals: readonly SignalRecord[];
  evidence: ReadonlyMap<string, readonly EvidenceTurn[]>;
  names: ReadonlyMap<string, string>;
  /** Model-written workflow names by workflow id; absent, workflows are named by their tools. */
  labels?: WorkflowLabels;
  /** What the choice model read from captured asks; absent without it. */
  insights?: WorkflowInsights | null;
  /** Defaults to `FIRST_READING_FLOOR`. */
  floor?: number;
}

function toSignalView(
  record: SignalRecord,
  names: ReadonlyMap<string, string>,
  evidenceDays: number,
  evidence: readonly EvidenceTurn[],
  labels?: WorkflowLabels,
): SignalView {
  const claim = claimModel(record, names, evidenceDays, labels);
  return {
    id: record.id,
    kind: record.kind,
    tier: record.tier,
    status: record.status,
    subject: claim.subject,
    claim: claim.claim,
    claimSegments: claim.claimSegments,
    figure: claim.figure,
    severity: record.severity,
    impact: record.impact,
    cost: claim.cost,
    n: record.n,
    interval: claim.interval,
    fix: claim.fix,
    fixRoute: claim.fixRoute,
    caveat: claim.caveat,
    turnSourceMix: record.turnSourceMix,
    evidence: { chart: claim.chart, turns: [...evidence], totalTurns: record.totalTurns },
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
  };
}

/** Tiles with no figures: before a first reading. */
function pendingTiles(end: Date, sub: string): HealthTile[] {
  return tilesFor([], { end, days: 7, coveredFrom: "", floor: Infinity }).map((tile) => ({
    ...tile,
    sub,
  }));
}

/** What the band, the shapes and the nudge read, by where the turns come from. */
interface SourceReadings {
  tiles: HealthTile[];
  shapes: TurnShapeView[];
  captureLevel: CaptureLevel;
  captureUnlocks: readonly CaptureUnlock[];
}

/**
 * The SDK readings, or for a project that only sends OpenTelemetry the ones
 * OTel can measure: no search tiles, the OTel shapes, and the OTel options
 * still to turn on. `mixed` keeps the SDK page.
 */
export function sourceReadings(
  mode: SourceMode,
  daily: readonly DayBucket[],
  total: DayBucket,
  w: TileWindow,
): SourceReadings {
  if (mode === "otel") {
    return {
      tiles: otelTilesFor(daily, w),
      shapes: otelShapesFor(total),
      captureLevel: otelCaptureLevel(total),
      captureUnlocks: otelCaptureUnlocks(total),
    };
  }
  const captureLevel = captureLevelOf(total);
  return {
    // SDK runs linked to OpenTelemetry model calls swap in cost and model calls per run.
    tiles: hasLinkedRuns(total) ? linkedTilesFor(daily, w) : tilesFor(daily, w),
    shapes: shapesFor(total),
    captureLevel,
    captureUnlocks: captureLevel === "content" ? [] : CAPTURE_UNLOCKS,
  };
}

export function buildHealthPageModel(inputs: PageInputs, now: Date = new Date()): HealthPageModel {
  const floor = inputs.floor ?? FIRST_READING_FLOOR;
  if (!inputs.run) {
    return {
      windowDays: inputs.windowDays,
      turns: inputs.liveTurns,
      floor,
      captureLevel: "events",
      turnSourceMix: { declared: 0, inferred: 0, otlp: 0 },
      tiles: pendingTiles(
        now,
        inputs.liveTurns >= floor
          ? "First reading is being computed."
          : "Waiting for enough turns.",
      ),
      flow: { nodes: [], edges: [], totalTools: 0 },
      shapes: shapesFor(emptyBucket("")),
      signals: [],
      tooEarly: [],
      lockedCount: 0,
      evidenceTurnsPerSignal: 0,
      captureUnlocks: CAPTURE_UNLOCKS,
      computedAt: null,
      signalWindowDays: null,
      sourceMode: "sdk",
      workflows: null,
      setup: null,
    };
  }
  const { summary, windowEnd } = inputs.run;
  const total = totalOver(summary.daily, windowDays(windowEnd, inputs.windowDays));
  const sourceMode = sourceModeOf(mixOrFallback(inputs.run.turnSourceMix, total.mix));
  const window = {
    end: windowEnd,
    days: inputs.windowDays,
    coveredFrom: summary.coveredFrom,
    floor,
  };
  const readings = sourceReadings(sourceMode, summary.daily, total, window);
  // The signals and the flow come from the run's window, not the selected one;
  // they claim only the days the project has actually sent turns in.
  const span =
    evidenceSpanDays(summary.daily, windowEnd, inputs.run.windowDays) || inputs.run.windowDays;
  const signals = inputs.signals.map((record) =>
    toSignalView(record, inputs.names, span, inputs.evidence.get(record.id) ?? [], inputs.labels),
  );
  const open = inputs.signals.map((r) => ({ key: signalKey(r), id: r.id, kind: r.kind }));
  return {
    windowDays: inputs.windowDays,
    turns: total.turns,
    floor,
    captureLevel: readings.captureLevel,
    turnSourceMix: total.mix,
    sourceMode,
    tiles: readings.tiles,
    flow: flowView(summary.flow, open, inputs.names),
    shapes: readings.shapes,
    signals,
    tooEarly: [],
    lockedCount: 0,
    evidenceTurnsPerSignal: Math.max(0, ...signals.map((s) => s.evidence.turns.length)),
    captureUnlocks: readings.captureUnlocks,
    computedAt: inputs.run.finishedAt?.toISOString() ?? null,
    signalWindowDays: span,
    workflows: workflowsView({
      stored: summary.workflows,
      signals,
      names: inputs.names,
      labels: inputs.labels,
      insights: inputs.insights,
    }),
    // Written by every run since the setup card; older summaries read as null.
    setup: parseStoredSetup((summary as RunSummary & { setup?: unknown }).setup),
    ...(typeof summary.unbuiltAtStart === "number" && summary.unbuiltAtStart > 0
      ? { unbuiltAtReading: summary.unbuiltAtStart }
      : {}),
  };
}
