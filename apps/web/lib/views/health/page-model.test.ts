import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunSummary } from "@/lib/readings/trace-signals/signals/analyze";
import {
  type DayBucket,
  emptyBucket,
  evidenceSpanDays,
  windowDays,
} from "@/lib/readings/trace-signals/signals/project-metrics";
import { healthReadiness, runWindowLabel, windowPhrase } from "@/lib/readings/trace-signals/view";
import { pendingHealthModel, shouldUseHealthFixture } from "@/lib/views/health/page-model";
import type { SignalRecord } from "@/lib/views/health/signals/claims-model";
import { buildHealthPageModel, type PageInputs } from "@/lib/views/health/signals/page-view";

test("the fixture is only ever read in development, and only for a project with no ledger", () => {
  assert.equal(shouldUseHealthFixture("development", false), true);
  assert.equal(shouldUseHealthFixture("development", true), false);
  assert.equal(shouldUseHealthFixture("test", false), false);
  assert.equal(shouldUseHealthFixture("production", false), false);
  assert.equal(shouldUseHealthFixture(undefined, false), false);
});

test("the pending model is the empty state on the requested window, never fake numbers", () => {
  const pending = pendingHealthModel(30);
  assert.equal(healthReadiness(pending), "no_telemetry");
  assert.equal(pending.windowDays, 30);
  assert.equal(pending.signals.length, 0);
  assert.ok(pending.tiles.every((tile) => tile.value === null));
  assert.equal(pending.computedAt, null);
});

const RUN_END = new Date("2026-09-28T14:00:00.000Z");

/** Daily buckets with `perDay` turns on each of the last `days` days before `RUN_END`. */
function recentDaily(days: number, perDay = 10, olderDay?: string): DayBucket[] {
  const daily = windowDays(RUN_END, days).map((day) => ({ ...emptyBucket(day), turns: perDay }));
  return olderDay ? [{ ...emptyBucket(olderDay), turns: 3 }, ...daily] : daily;
}

function runWith(windowDaysOfRun: number, daily: DayBucket[]): PageInputs["run"] {
  const summary: RunSummary = {
    version: 1,
    coveredFrom: daily[0]!.day,
    daily,
    flow: { nodes: [], edges: [], totalTools: 0 },
  };
  return { windowEnd: RUN_END, windowDays: windowDaysOfRun, finishedAt: RUN_END, summary };
}

const MISS: SignalRecord = {
  id: "sig-1",
  kind: "first_try_miss",
  status: "open",
  tier: "deterministic",
  subjectKind: "tool",
  subjectKey: "assign_task",
  subjectIds: ["assign_task"],
  entryKind: "tool",
  severity: 0.6,
  impact: 74,
  n: 104,
  metrics: { k: 74, n: 104, share: 0.7115, extraSearches: 74 },
  turnIds: [],
  traceEventIds: [],
  totalTurns: 74,
  turnSourceMix: { declared: 104, inferred: 0, otlp: 0 },
  firstSeenAt: RUN_END.toISOString(),
  lastSeenAt: RUN_END.toISOString(),
};

test("evidence span: the run's window, cut to the days since the project's first turn", () => {
  assert.equal(
    evidenceSpanDays(recentDaily(22), RUN_END, 90),
    22,
    "three weeks and a partial day of turns",
  );
  assert.equal(
    evidenceSpanDays(recentDaily(22), RUN_END, 7),
    7,
    "a window shorter than the history is covered in full",
  );
  assert.equal(
    evidenceSpanDays(recentDaily(5, 10, "2026-05-01"), RUN_END, 30),
    30,
    "a turn before the window means an older project",
  );
  assert.equal(evidenceSpanDays([], RUN_END, 30), 0);
});

test("cards claim the evidence span, and the list is labelled when it differs from the window", () => {
  const inputs = (windowDays: 7 | 30 | 90, run: PageInputs["run"]): PageInputs => ({
    windowDays,
    run,
    liveTurns: 0,
    signals: [MISS],
    evidence: new Map(),
    names: new Map(),
  });
  // A 90-day run over a project that has sent turns for 22 days.
  const young = runWith(90, recentDaily(22));
  const on30 = buildHealthPageModel(inputs(30, young));
  assert.equal(on30.signalWindowDays, 22);
  assert.equal(on30.signals[0]!.cost, "74 extra searches in the last 22 days.", "not 90 days");
  assert.equal(runWindowLabel(on30), "last 22 days");
  assert.equal(windowPhrase(on30.windowDays), "in the last 30 days");

  // A 30-day run of an older project, read on 30 days: nothing to label.
  const settled = buildHealthPageModel(inputs(30, runWith(30, recentDaily(30, 10, "2026-08-01"))));
  assert.equal(settled.signalWindowDays, 30);
  assert.equal(runWindowLabel(settled), null);
  assert.match(settled.signals[0]!.cost, /in the last 30 days\.$/);

  // The same run read on 7 days: the band moves, the list says it did not.
  const on7 = buildHealthPageModel(inputs(7, runWith(30, recentDaily(30, 10, "2026-08-01"))));
  assert.equal(runWindowLabel(on7), "last 30 days");
  assert.equal(windowPhrase(7), "this week");
  assert.equal(windowPhrase(90), "in the last 90 days");
  assert.equal(buildHealthPageModel(inputs(7, null)).signalWindowDays, null);
});

test("before a first run the live turn count decides collecting or ready", () => {
  const base = {
    windowDays: 7 as const,
    run: null,
    signals: [],
    evidence: new Map(),
    names: new Map(),
  };
  assert.equal(healthReadiness(buildHealthPageModel({ ...base, liveTurns: 14 })), "collecting");
  const ready = buildHealthPageModel({ ...base, liveTurns: 80 });
  assert.equal(healthReadiness(ready), "ready");
  assert.ok(
    ready.tiles.every(
      (tile) => tile.value === null && tile.sub === "First reading is being computed.",
    ),
  );
});
