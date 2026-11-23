import type { ProjectStats } from "@/lib/readings/trace-signals/signals/accumulators";
import {
  entrySubject,
  evidenceOf,
  laneOf,
  round4,
  sortedEntries,
} from "@/lib/readings/trace-signals/signals/build";
import { DEFAULT_FLOORS, type Floors } from "@/lib/readings/trace-signals/signals/catalog";
import { median, quantile, wilson, wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import type {
  AnalysisContext,
  DetectedSignal,
  DetectionResult,
} from "@/lib/readings/trace-signals/signals/types";
import type { SignalKind } from "@/lib/readings/trace-signals/view";

/**
 * Health signals: failures, slowness, tools nobody reaches, searches that lead
 * nowhere.
 *
 * - `error_loop`: a tool failing often, or failing twice in one turn in several
 *   turns. Severity is the Wilson lower bound of its error rate.
 * - `latency_outlier`: a tool whose p95 (over a reservoir of its durations)
 *   exceeds both the absolute floor and a multiple of the project's median
 *   call. Severity is the Wilson lower bound of the sample's share above that
 *   bar; impact is seconds of waiting, calls times (p95 - median).
 * - `dead_tool`: catalog tools never listed and never run in the window, when
 *   the ledger is old and busy enough to say so and `tool_usage_counters`
 *   agrees. One project-level signal naming them all, not one card per tool.
 *   Severity is the Wilson lower bound of the dead share of the catalog.
 * - `abandoned_search`: searched turns that ran nothing. Not measurable (so
 *   never emitted, never marked missed) when the window holds no invocation at
 *   all, which is what an OTLP-only project looks like before Phase 1b.
 */

const DAY_MS = 86_400_000;
const DEAD_TOOLS_NAMED = 50;

export function detectHealth(
  stats: ProjectStats,
  context: AnalysisContext,
  floors: Floors = DEFAULT_FLOORS,
): DetectionResult {
  const entries = sortedEntries(stats.entries);
  const projectMedian = median(stats.latency.values());
  const measured = new Set<SignalKind>(["error_loop", "latency_outlier"]);
  const dead = deadTool(stats, context, floors);
  if (dead.measured) measured.add("dead_tool");
  const abandoned = abandonedSearch(stats, floors);
  if (abandoned.measured) measured.add("abandoned_search");
  return {
    signals: [
      ...entries.flatMap((entry) => errorLoop(entry, floors)),
      ...entries.flatMap((entry) => latencyOutlier(entry, projectMedian, floors)),
      ...dead.signals,
      ...abandoned.signals,
    ],
    measured,
  };
}

type Entry = ReturnType<typeof sortedEntries>[number];

function errorLoop(entry: Entry, floors: Floors): DetectedSignal[] {
  const f = floors.error_loop;
  const low = wilsonLow(entry.errors, entry.invocations);
  if (entry.errors < f.minErrors) return [];
  if (entry.loopTurns < f.minLoopTurns && low < f.minLow) return [];
  const interval = wilson(entry.errors, entry.invocations);
  return [
    {
      kind: "error_loop",
      ...entrySubject(entry),
      lane: laneOf(entry.mix),
      severity: round4(low),
      impact: entry.errors + entry.loopTurns,
      n: entry.invocations,
      route: "show_turns",
      metrics: {
        errors: entry.errors,
        invocations: entry.invocations,
        errorTurns: entry.errorTurns,
        loopTurns: entry.loopTurns,
        retries: entry.retries,
        errorShare: round4(entry.errors / Math.max(1, entry.invocations)),
        low: round4(interval?.low ?? 0),
        high: round4(interval?.high ?? 1),
      },
      evidence: evidenceOf(entry.evidence.errorLoop.values(), entry.errorTurns),
    },
  ];
}

function latencyOutlier(
  entry: Entry,
  projectMedian: number | null,
  floors: Floors,
): DetectedSignal[] {
  const f = floors.latency_outlier;
  const sample = entry.latency.values();
  const n = entry.latency.total;
  if (n < f.minN || projectMedian === null) return [];
  const p95 = quantile(sample, 0.95);
  const bar = Math.max(f.minP95Ms, f.medianMultiple * projectMedian);
  if (p95 === null || p95 <= bar) return [];
  const slow = sample.filter((ms) => ms > bar).length;
  const slowCalls = entry.slowCalls.values().filter((call) => call.tookMs > bar);
  return [
    {
      kind: "latency_outlier",
      ...entrySubject(entry),
      lane: laneOf(entry.mix),
      severity: round4(wilsonLow(slow, sample.length)),
      impact: Math.round((n * Math.max(0, p95 - projectMedian)) / 1_000),
      n,
      route: "none",
      metrics: {
        p95Ms: Math.round(p95),
        medianMs: Math.round(projectMedian),
        barMs: Math.round(bar),
        calls: n,
        sampled: sample.length,
        slowShare: round4(slow / sample.length),
      },
      evidence: evidenceOf(slowCalls, Math.round((slow / sample.length) * n)),
    },
  ];
}

interface Measured {
  measured: boolean;
  signals: DetectedSignal[];
}

function deadTool(stats: ProjectStats, context: AnalysisContext, floors: Floors): Measured {
  const f = floors.dead_tool;
  const tools = context.catalog.filter((entry) => entry.kind === "tool");
  const oldEnough =
    context.ledgerStartedAt !== null &&
    context.windowEnd.getTime() - context.ledgerStartedAt.getTime() >= f.minLedgerDays * DAY_MS;
  if (!oldEnough || stats.turns < f.minTurns || tools.length === 0)
    return { measured: false, signals: [] };
  const usedRecently = new Set(
    context.usage
      .filter((u) => u.calls > 0 && u.lastUsedAt.getTime() >= context.windowStart.getTime())
      .map((u) => u.toolId),
  );
  const dead = tools
    .map((tool) => tool.entryId)
    .filter((id) => !stats.seenTools.has(id) && !usedRecently.has(id))
    .sort();
  if (dead.length === 0) return { measured: true, signals: [] };
  const interval = wilson(dead.length, tools.length);
  return {
    measured: true,
    signals: [
      {
        kind: "dead_tool",
        subjectKind: "project",
        subjectKey: "project",
        subjectIds: dead.slice(0, DEAD_TOOLS_NAMED),
        entryKind: "tool",
        lane: laneOf(stats.mix),
        severity: round4(interval?.low ?? 0),
        impact: dead.length,
        n: stats.turns,
        route: "retire_tool",
        metrics: {
          dead: dead.length,
          catalogTools: tools.length,
          deadShare: round4(dead.length / tools.length),
          low: round4(interval?.low ?? 0),
          high: round4(interval?.high ?? 1),
        },
        evidence: { turnIds: [], traceEventIds: [], totalTurns: 0, turnSourceMix: stats.mix },
      },
    ],
  };
}

function abandonedSearch(stats: ProjectStats, floors: Floors): Measured {
  const f = floors.abandoned_search;
  const n = stats.measurableWithSearch;
  if (stats.invocations === 0 || n === 0) return { measured: false, signals: [] };
  const low = wilsonLow(stats.abandoned, n);
  if (n < f.minTurns || low < f.minLow) return { measured: true, signals: [] };
  const interval = wilson(stats.abandoned, n);
  return {
    measured: true,
    signals: [
      {
        kind: "abandoned_search",
        subjectKind: "project",
        subjectKey: "project",
        subjectIds: [],
        entryKind: "tool",
        lane: laneOf(stats.mix),
        severity: round4(low),
        impact: stats.abandoned,
        n,
        route: "workflow_skill",
        metrics: {
          abandoned: stats.abandoned,
          turns: n,
          share: round4(stats.abandoned / n),
          low: round4(interval?.low ?? 0),
          high: round4(interval?.high ?? 1),
        },
        evidence: evidenceOf(stats.abandonedEvidence.values(), stats.abandoned),
      },
    ],
  };
}
