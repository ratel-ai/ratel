import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import {
  detectWorkflowSignals,
  WORKFLOW_THRESHOLDS,
  type WorkflowWithHealth,
} from "@/lib/readings/trace-signals/workflows/detect";
import { workflowHealth } from "@/lib/readings/trace-signals/workflows/health";
import { mineWorkflows } from "@/lib/readings/trace-signals/workflows/mine";
import {
  byIdMap,
  type Call,
  many,
  wfTurn,
} from "@/lib/readings/trace-signals/workflows/test-fixtures";
import type { WorkflowSignal } from "@/lib/readings/trace-signals/workflows/types";

/**
 * The planted demo world in miniature, 40 runs each:
 * - plan:    list, backlog, estimate, assign; healthy, its order varies.
 * - close:   find_pr, link_pr, update_status, notify; 12 runs fail at update_status.
 * - onboard: invite, create_task, link_doc; 15 s a run, the others take 2 s.
 * - report:  fetch, summarize, export; always in that order.
 */
function world(): SignalTurn[] {
  const swap = (i: number, calls: string[]): string[] =>
    i % 2 === 0 ? calls : [calls[1]!, calls[0]!, ...calls.slice(2)];
  const close = (i: number): Call[] =>
    i < 12
      ? [...swap(i, ["find_pr", "link_pr"]), { tool: "update_status", outcome: "error" }]
      : swap(i, ["find_pr", "link_pr", "update_status", "notify"]);
  return [
    ...many(40, (i) =>
      wfTurn(
        i % 2 === 0
          ? ["list", "backlog", "estimate", "assign"]
          : ["backlog", "list", "assign", "estimate"],
      ),
    ),
    ...many(40, (i) => wfTurn(close(i))),
    ...many(40, (i) =>
      wfTurn(swap(i, ["invite", "create_task", "link_doc"]), { durationMs: 15_000 }),
    ),
    ...many(40, () => wfTurn(["fetch", "summarize", "export"])),
    ...many(1, () =>
      wfTurn([
        { tool: "list", outcome: "ok" },
        "backlog",
        "estimate",
        { tool: "assign", outcome: "error" },
      ]),
    ),
  ];
}

function entriesOf(turns: readonly SignalTurn[]): WorkflowWithHealth[] {
  const result = mineWorkflows(turns);
  const byId = byIdMap(turns);
  return result.workflows.map((workflow) => ({ workflow, health: workflowHealth(workflow, byId) }));
}

const about = (signals: readonly WorkflowSignal[], kind: WorkflowSignal["kind"]) =>
  signals.filter((s) => s.kind === kind).map((s) => [...s.subjectIds].sort().join(","));

test("the planted world mines its four workflows", () => {
  const cores = entriesOf(world())
    .map((e) => e.workflow.coreTools.join(","))
    .sort();
  assert.deepEqual(cores, [
    "assign,backlog,estimate,list",
    "create_task,invite,link_doc",
    "export,fetch,summarize",
    "find_pr,link_pr,notify,update_status",
  ]);
});

test("workflow_failing fires on the failing workflow, names its step, and stays quiet on the healthy one", () => {
  const signals = detectWorkflowSignals(entriesOf(world()));
  assert.deepEqual(about(signals, "workflow_failing"), ["find_pr,link_pr,notify,update_status"]);
  const failing = signals.find((s) => s.kind === "workflow_failing")!;
  assert.equal(failing.metrics.completion, 0.7);
  assert.equal(failing.metrics.failingStep, "update_status");
  assert.equal(failing.metrics.failingStepShare, 1);
  assert.equal(failing.impact, 12);
  assert.equal(failing.n, 40);
  assert.ok(failing.severity >= 0.15 && failing.severity < 0.3);
  assert.equal(failing.route, "show_turns");
  assert.equal(failing.subjectKind, "workflow");
  assert.equal(failing.evidence.turnIds.length, 5);
  assert.equal(failing.evidence.totalTurns, 12);
  assert.ok(
    failing.evidence.traceEventIds.every((id) => id?.endsWith("-e2")),
    "points at the failing call",
  );
});

test("workflow_slow fires on the slow workflow only, with its slowest step", () => {
  const signals = detectWorkflowSignals(entriesOf(world()));
  assert.deepEqual(about(signals, "workflow_slow"), ["create_task,invite,link_doc"]);
  const slow = signals.find((s) => s.kind === "workflow_slow")!;
  assert.equal(slow.metrics.medianMs, 15_000);
  assert.equal(slow.metrics.baselineMs, 2_000);
  assert.equal(slow.metrics.ratio, 7.5);
  assert.equal(slow.severity, 0.8667);
  assert.equal(slow.impact, 40 * 13);
});

test("workflow_slow needs both the ratio and the 5 s floor", () => {
  const fast = [
    ...many(30, () => wfTurn(["a", "b"], { durationMs: 500 })),
    ...many(30, () => wfTurn(["c", "d"], { durationMs: 500 })),
    ...many(30, () => wfTurn(["e", "f"], { durationMs: 4_000 })),
  ];
  assert.deepEqual(
    about(detectWorkflowSignals(entriesOf(fast)), "workflow_slow"),
    [],
    "8x but under 5 s",
  );
  const even = [
    ...many(30, () => wfTurn(["a", "b"], { durationMs: 6_000 })),
    ...many(30, () => wfTurn(["c", "d"], { durationMs: 6_000 })),
  ];
  assert.deepEqual(
    about(detectWorkflowSignals(entriesOf(even)), "workflow_slow"),
    [],
    "slow, but no slower than the rest",
  );
});

test("workflow_fixed_chain fires on a stable 3-tool chain and not on a varying or 2-tool one", () => {
  const signals = detectWorkflowSignals(entriesOf(world()));
  assert.deepEqual(about(signals, "workflow_fixed_chain"), ["export,fetch,summarize"]);
  const chain = signals.find((s) => s.kind === "workflow_fixed_chain")!;
  assert.deepEqual(chain.subjectIds, ["fetch", "summarize", "export"]);
  assert.deepEqual(chain.metrics.typicalOrder, ["fetch", "summarize", "export"]);
  assert.equal(chain.metrics.orderStability, 1);
  assert.equal(chain.route, "workflow_skill");
  assert.equal(chain.impact, 80);
  assert.ok(chain.severity > 0.9);
  const pairs = many(40, () => wfTurn(["a", "b"]));
  assert.deepEqual(about(detectWorkflowSignals(entriesOf(pairs)), "workflow_fixed_chain"), []);
});

test("nothing fires under 20 runs", () => {
  const small = [
    ...many(19, (i) =>
      wfTurn(["x", "y", { tool: "z", outcome: i < 10 ? "error" : "ok" }], { durationMs: 60_000 }),
    ),
    ...many(19, () => wfTurn(["p", "q"], { durationMs: 1_000 })),
  ];
  assert.deepEqual(detectWorkflowSignals(entriesOf(small)), []);
  assert.equal(WORKFLOW_THRESHOLDS.failing.minRuns, 20);
});

test("signals carry the lane of their runs", () => {
  const otlp = many(30, () => wfTurn(["fetch", "summarize", "export"], { turnSource: "otlp" }));
  const [signal] = detectWorkflowSignals(entriesOf(otlp));
  assert.equal(signal?.lane, "otlp");
  assert.deepEqual(signal?.evidence.turnSourceMix, { declared: 0, inferred: 0, otlp: 30 });
});
