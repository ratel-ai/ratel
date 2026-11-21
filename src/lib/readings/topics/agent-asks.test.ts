import assert from "node:assert/strict";
import { test } from "node:test";
import { agentRunAsk, agentRunAsks } from "@/lib/readings/topics/agent-asks";

/**
 * Owned (ADR-0030): upstream's cases, less the Evals job kinds (`run_eval_set`,
 * `simulate_eval_set`), which are not ported; two kinds this tree has stand in.
 */

const PROJECT = "9bedca48-de2b-4d50-9560-e3da19eec4c9";

test("a job's machine ask reads as the job in words, without the project id and the payload", () => {
  assert.equal(agentRunAsk(`cluster_intents for project ${PROJECT}`), "Cluster intents");
  assert.equal(agentRunAsk(`label_workflows for project ${PROJECT}\n{}`), "Label workflows");
  assert.equal(
    agentRunAsk(`draft_fix for project ${PROJECT}\n{"fixId":"7f3c","mode":"auto"}`),
    "Draft fix",
  );
  assert.equal(
    agentRunAsk(`assign_topics for project ${PROJECT} {}`),
    "Assign topics",
    "as a reading flattens it",
  );
});

test("a job's ask in words (RC-834) reads as the same job in words, with or without its ids", () => {
  assert.equal(agentRunAsk("Cluster intents"), "Cluster intents");
  assert.equal(agentRunAsk("Draft a fix (fixId 7f3c)"), "Draft fix");
  assert.equal(agentRunAsk("Run a what-if step (runId r-1)"), "What if step");
  assert.equal(agentRunAsk("Simulate a task eval (runId r-1)"), "Simulate task eval");
});

test("the old and the new ask of one job kind are one ask", () => {
  const derived = agentRunAsks(
    new Map([
      ["old", { text: `draft_fix for project ${PROJECT}\n{"fixId":"7f3c"}` }],
      ["new", { text: "Draft a fix (fixId 9a1b)" }],
    ]),
  );
  assert.deepEqual(
    [...derived],
    [
      ["old", { text: "Draft fix", source: "derived" }],
      ["new", { text: "Draft fix", source: "derived" }],
    ],
  );
});

test("an ask in a person's words is left alone", () => {
  assert.equal(agentRunAsk("Draft a fix for the refund flow"), null);
  assert.equal(agentRunAsk("Draft a fix (the refund one)"), null);
  assert.equal(agentRunAsk("Draft a fix (requestedBy user_1)"), null);
  assert.equal(agentRunAsk("cluster intents"), null);
  assert.equal(agentRunAsk("Cluster the intents for project Apollo"), null);
  assert.equal(agentRunAsk(`What is the status for project ${PROJECT}?`), null);
  assert.equal(agentRunAsk(`cluster_intents for project ${PROJECT}-extra`), null);
  assert.equal(agentRunAsk("cluster_intents for project p-1"), null);
  assert.equal(agentRunAsk(""), null);
});

test("only the machine asks are derived, by turn", () => {
  const derived = agentRunAsks(
    new Map([
      ["t1", { text: `cluster_intents for project ${PROJECT}` }],
      ["t2", { text: "Where is order 1042?" }],
    ]),
  );
  assert.deepEqual([...derived], [["t1", { text: "Cluster intents", source: "derived" }]]);
});
