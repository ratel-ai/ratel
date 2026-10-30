import type { StoredWorkflow } from "@/lib/readings/trace-signals/signals/workflow-stored";
import type { SignalKind, SignalView } from "@/lib/readings/trace-signals/view";

/** Test fixtures for the Workflows section: a stored workflow and a bare signal view. */

export function storedItem(
  id: string,
  order: readonly string[],
  over: Partial<StoredWorkflow> = {},
): StoredWorkflow {
  return {
    id,
    fingerprint: id,
    coreTools: [...order],
    optionalTools: [],
    helperTools: [],
    entryTool: order[0]!,
    typicalOrder: [...order],
    orderStability: 0.9,
    runs: 40,
    share: 0.2,
    health: {
      completion: 0.7,
      completedRuns: 28,
      failedRuns: 12,
      failingStep: { toolId: order[1]!, count: 9, share: 0.75 },
      medianMs: 4_200,
      p95Ms: 9_000,
      slowestStep: { toolId: order[0]!, count: 3_000, share: 0.6, medianMs: 2_400 },
      retryRuns: 0,
      errorRuns: 12,
      meanToolCalls: order.length,
      turnSourceMix: { declared: 0, inferred: 0, otlp: 40 },
    },
    examples: {
      failed: [
        { turnId: "t-f1", traceEventId: "e-f1" },
        { turnId: "t-f2", traceEventId: null },
        { turnId: "t-f3", traceEventId: "e-f3" },
      ],
      slow: [{ turnId: "t-s1", traceEventId: "e-s1" }],
      recent: [
        { turnId: "t-f1", traceEventId: "e-f1" },
        { turnId: "t-r1", traceEventId: null },
        { turnId: "t-r2", traceEventId: null },
      ],
    },
    ...over,
  };
}

export function signal(
  id: string,
  kind: SignalKind,
  subjectKind: SignalView["subject"]["kind"],
  key: string,
  chips: readonly string[] = [],
): SignalView {
  return {
    id,
    kind,
    tier: "deterministic",
    status: "open",
    subject: {
      kind: subjectKind,
      key,
      label: key,
      chips: chips.map((c) => ({ id: c, label: c, entryKind: "tool" as const })),
    },
    claim: `claim of ${id}`,
    claimSegments: [{ kind: "text", text: `claim of ${id}` }],
    figure: { value: 0.5, unit: "share", display: "50%", raw: "1 of 2" },
    severity: 0.5,
    impact: 1,
    cost: "",
    n: 2,
    interval: null,
    fix: "Do it.",
    fixRoute: "none",
    caveat: null,
    turnSourceMix: { declared: 0, inferred: 0, otlp: 2 },
    evidence: { chart: null, turns: [], totalTurns: 0 },
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-01T00:00:00.000Z",
  };
}
