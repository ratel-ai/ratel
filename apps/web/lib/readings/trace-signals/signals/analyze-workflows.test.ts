import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AnalysisResult,
  analyzeTurns,
  RUN_BOUND_KINDS,
} from "@/lib/readings/trace-signals/signals/analyze";
import {
  contextFor,
  fresh,
  signalTurns,
  times,
} from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import { WORKFLOW_SIGNAL_KINDS } from "@/lib/readings/trace-signals/signals/workflow-run";
import { storedHelperTools } from "@/lib/readings/trace-signals/signals/workflow-stored";
import { many, wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";

/**
 * Workflows inside a whole signal run: a planted failing workflow comes out as
 * a `workflow_failing` signal with its evidence, and a run whose turns hold
 * no workflow reads exactly as it did before workflows existed (the baseline
 * is the same run with workflow collection capped at zero turns).
 */

const isWorkflowKind = (kind: string): boolean =>
  (WORKFLOW_SIGNAL_KINDS as readonly string[]).includes(kind);

function baseline(turns: readonly SignalTurn[]): AnalysisResult {
  return analyzeTurns(turns, contextFor(turns), { maxWorkflowTurns: 0 });
}

test("a planted failing workflow produces a workflow_failing signal with evidence", () => {
  const turns = [
    ...many(40, (i) =>
      wfTurn([
        "plan_trip",
        "find_hotels",
        i % 2 === 0 ? { tool: "book_hotel", outcome: "error" } : "book_hotel",
      ]),
    ),
    ...many(40, () => wfTurn(["find_task", "assign_task"])),
  ];
  const result = analyzeTurns(turns, contextFor(turns));
  const failing = result.signals.filter((s) => s.kind === "workflow_failing");
  assert.equal(failing.length, 1);
  const [signal] = failing;
  assert.deepEqual(signal!.subjectIds, ["plan_trip", "find_hotels", "book_hotel"]);
  assert.equal(signal!.metrics.failingStep, "book_hotel");
  assert.equal(signal!.evidence.totalTurns, 20);
  assert.equal(signal!.evidence.turnIds.length, 5);
  const failedIds = new Set(
    turns.filter((t) => t.steps.some((s) => s.outcome === "error")).map((t) => t.id),
  );
  assert.ok(
    signal!.evidence.turnIds.every((id) => failedIds.has(id)),
    "evidence is failed runs only",
  );
  for (const kind of WORKFLOW_SIGNAL_KINDS) assert.ok(result.measured.has(kind), kind);
  const stored = result.summary.workflows;
  assert.ok(stored);
  assert.equal(stored.items.length, 2);
  assert.equal(stored.items.find((item) => item.id === signal!.subjectKey)?.health.failedRuns, 20);
});

test("last run's ids reach the signals through the context", () => {
  const turns = many(30, (i) =>
    wfTurn(["a", "b", "c", i < 15 ? { tool: "d", outcome: "error" } : "d"]),
  );
  const result = analyzeTurns(
    turns,
    contextFor(turns, { previousWorkflows: [{ id: "kept", coreTools: ["a", "b", "c"] }] }),
  );
  assert.equal(result.summary.workflows?.items[0]?.id, "kept");
  assert.equal(result.signals.find((s) => s.kind === "workflow_failing")?.subjectKey, "kept");
});

test("SDK fixtures read exactly as before for every existing kind, with or without a mined workflow", () => {
  for (const [retries, mined] of [
    [8, 0],
    [12, 1],
  ] as const) {
    const sdk = signalTurns([
      ...times(retries, () => fresh().search(["a", "b"]).invoke("a").error("a").invoke("b")),
      ...times(30, () => fresh().search(["a"]).invoke("a")),
      ...times(25, () => fresh().search(["c", "d"])),
    ]);
    const before = baseline(sdk);
    const after = analyzeTurns(sdk, contextFor(sdk));
    assert.equal(
      after.signals.filter((s) => isWorkflowKind(s.kind)).length,
      0,
      "too few runs for a workflow signal",
    );
    assert.deepEqual(after.signals, before.signals);
    assert.deepEqual(
      [...after.measured].filter((k) => !isWorkflowKind(k)).sort(),
      [...before.measured].sort(),
    );
    const { workflows, ...rest } = after.summary;
    assert.deepEqual(rest, before.summary);
    assert.equal(workflows?.items.length, mined);
  }
});

test("a run without a single tool call stores exactly the summary it did before", () => {
  const searches = signalTurns(times(40, () => fresh().search(["a", "b"])));
  const before = baseline(searches);
  const after = analyzeTurns(searches, contextFor(searches));
  assert.deepEqual(after.summary, before.summary);
  assert.deepEqual([...after.measured].sort(), [...before.measured].sort());
  assert.deepEqual(after.signals, before.signals);
});

test("runs mixed together read no per-run kind: nothing detected, nothing measured, so nothing resolves", () => {
  // A busy process without turn ids: every guessed run is cut at the cap and repeats tools from several users.
  const mixed = many(40, () => ({
    ...wfTurn(["find_pr", "find_pr", "find_pr", "link_pr", "link_pr", "notify"]),
    endedBy: "cap" as const,
  }));
  const result = analyzeTurns(mixed, contextFor(mixed));
  assert.equal(result.summary.workflows?.basis?.blocked, "mixed_runs");
  assert.ok(
    result.signals.every((s) => !RUN_BOUND_KINDS.has(s.kind)),
    result.signals.map((s) => s.kind).join(","),
  );
  for (const kind of RUN_BOUND_KINDS) assert.equal(result.measured.has(kind), false, kind);
  const calm = many(40, () =>
    wfTurn(["find_pr", "find_pr", "find_pr", "link_pr", "link_pr", "notify"]),
  );
  assert.ok(
    analyzeTurns(calm, contextFor(calm)).measured.has("repeat_invoke"),
    "the same runs ended by quiet gaps are read",
  );
});

test("the run stores the miner's helper tools, so other readers set them aside with the same set", () => {
  const turns = [
    ...many(30, () => wfTurn(["sync", "plan_trip", "find_hotels", "book_hotel"])),
    ...many(30, () => wfTurn(["sync", "find_task", "assign_task"])),
    ...many(30, () => wfTurn(["lookup_order", "notify"])),
    ...many(40, () => wfTurn(["find_task"])),
  ];
  const stored = analyzeTurns(turns, contextFor(turns)).summary.workflows;
  assert.deepEqual(
    stored?.ubiquitousTools,
    ["sync"],
    "in 60 of the 90 multi-tool turns; find_task's 40 single-tool turns do not count",
  );
  assert.deepEqual(storedHelperTools(stored), ["sync"]);
  // A run stored before the set was kept reads as no helpers.
  const { ubiquitousTools: _dropped, ...older } = stored!;
  assert.deepEqual(storedHelperTools(older), []);
  assert.deepEqual(storedHelperTools(null), []);
  assert.deepEqual(
    storedHelperTools({ ubiquitousTools: ["a", 3 as unknown as string] }),
    ["a"],
    "stored JSON is untrusted",
  );
});
