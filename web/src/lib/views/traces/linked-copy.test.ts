import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowModelText } from "@/components/console/health/workflow-row-model";
import { linkedModelText } from "@/lib/views/traces/turn-linked";

/** The words a linked run and a linked workflow print. */

test("a workflow's model line: cost, model calls, time in the model", () => {
  assert.equal(
    workflowModelText({ costUsd: 0.031, modelCalls: 4, modelShare: 0.7 }),
    "$0.03 a run · 4 model calls · 70% of the time in the model",
  );
  assert.equal(
    workflowModelText({ costUsd: null, modelCalls: 1, modelShare: 0.42 }),
    "1 model call · 42% of the time in the model",
  );
});

test("a linked run's model line on its Traces page", () => {
  assert.equal(
    linkedModelText({ modelCalls: 4, costUsd: 0.027, modelMs: 6_200 }),
    "4 model calls · $0.03 · 6.2 s in the model",
  );
  assert.equal(
    linkedModelText({ modelCalls: 1, costUsd: null, modelMs: 800 }),
    "1 model call · 800 ms in the model",
  );
});
