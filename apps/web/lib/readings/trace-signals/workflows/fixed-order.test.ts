import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FLOORS } from "@/lib/readings/trace-signals/signals/catalog";
import { detectWorkflowSignals, WORKFLOW_THRESHOLDS } from "./detect";
import { FIXED_ORDER, FIXED_PAIR_ORDER, runsInFixedOrder } from "./fixed-order";
import type { Workflow, WorkflowHealth } from "./types";

/**
 * Owned (ADR-0030): upstream also checks that the tool crafter drafts a compose fix for
 * exactly the tasks that raise the issue; that case lands with the tool crafter.
 */

const ORDER = ["find_pr", "link_pr", "update_status", "notify"];

function task(
  runs: number,
  orderStability: number,
): { workflow: Workflow; health: WorkflowHealth } {
  const workflow: Workflow = {
    id: "wf-chain",
    coreTools: [...ORDER].sort(),
    optionalTools: [],
    helperTools: [],
    entryTool: ORDER[0]!,
    typicalOrder: ORDER,
    orderStability,
    orderRuns: runs,
    orderStableRuns: Math.round(runs * orderStability),
    memberTurnIds: [],
    runs,
    share: 0.5,
    seedTools: [...ORDER].sort(),
    seedSupport: runs,
  };
  const health: WorkflowHealth = {
    workflowId: workflow.id,
    runs,
    completedRuns: runs,
    completion: 1,
    failedRuns: 0,
    failingStep: null,
    medianMs: 1_000,
    p95Ms: 2_000,
    slowestStep: null,
    retryRuns: 0,
    errorRuns: 0,
    meanToolCalls: 4,
    turnSourceMix: { declared: runs, inferred: 0, otlp: 0 },
    failedExamples: [],
    slowExamples: [],
    recentExamples: [],
  };
  return { workflow, health };
}

function verdicts(runs: number, orderStability: number) {
  const entry = task(runs, orderStability);
  const issue = detectWorkflowSignals([entry]).some((s) => s.kind === "workflow_fixed_chain");
  return { issue, rule: runsInFixedOrder(entry.workflow) };
}

test("the issue and the rule read one fixed-order threshold", () => {
  assert.deepEqual(WORKFLOW_THRESHOLDS.fixedChain, {
    minRuns: FIXED_ORDER.minRuns,
    minCoreSize: FIXED_ORDER.minSteps,
    minOrderStability: FIXED_ORDER.minShare,
  });
  assert.equal(DEFAULT_FLOORS.workflow_fixed_chain.minRuns, FIXED_ORDER.minRuns);
  assert.equal(DEFAULT_FLOORS.workflow_fixed_chain.minOrderStability, FIXED_ORDER.minShare);
  assert.equal(DEFAULT_FLOORS.workflow_fixed_chain.minCoreSize, FIXED_ORDER.minSteps);
});

test("a task raises the issue exactly when the rule holds", () => {
  assert.deepEqual(verdicts(12, 0.85), { issue: false, rule: false });
  assert.deepEqual(verdicts(30, 0.85), { issue: false, rule: false });
  assert.deepEqual(verdicts(19, 1), { issue: false, rule: false });
  assert.deepEqual(verdicts(25, 0.92), { issue: true, rule: true });
});

test("a pair reads the same rule with two steps: the runs and the share stay the one rule's", () => {
  assert.deepEqual(FIXED_PAIR_ORDER, {
    minRuns: FIXED_ORDER.minRuns,
    minShare: FIXED_ORDER.minShare,
    minSteps: 2,
  });
  const pair = { runs: 25, coreTools: ["find_pr", "link_pr"], orderStability: 0.92 };
  assert.equal(runsInFixedOrder(pair), false, "two steps are no chain");
  assert.equal(runsInFixedOrder(pair, FIXED_PAIR_ORDER), true);
  assert.equal(runsInFixedOrder({ ...pair, runs: 19 }, FIXED_PAIR_ORDER), false);
  assert.equal(runsInFixedOrder({ ...pair, orderStability: 0.85 }, FIXED_PAIR_ORDER), false);
});
