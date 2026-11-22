import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkedTools, segmentBands, sessionStep } from "@/lib/views/tasks/session";

test("a session step: a search with its hits, a call by its catalog name, a failure said in words", () => {
  const base = {
    ordinal: 1,
    kind: "invoke",
    targetType: "tool",
    targetId: null,
    outcome: "ok",
    tookMs: null,
    hitCount: null,
  };
  assert.deepEqual(sessionStep({ ...base, kind: "search", hitCount: 3 }, {}), {
    key: 1,
    kind: "search",
    toolId: null,
    label: "Search",
    title: "Search, 3 listed",
    failed: false,
  });
  assert.deepEqual(
    sessionStep({ ...base, ordinal: 2, targetId: "find", tookMs: 12 }, { find: "Find task" }),
    {
      key: 2,
      kind: "call",
      toolId: "find",
      label: "Find task",
      title: "Find task, 12 ms",
      failed: false,
    },
  );
  const skill = sessionStep(
    { ...base, ordinal: 3, targetType: "skill", targetId: "triage", outcome: "error" },
    {},
  );
  assert.equal(skill.toolId, "skill:triage");
  assert.equal(skill.title, "skill:triage, failed");
  assert.equal(skill.failed, true);
});

test("the tools to mark come from the URL, trimmed and bounded", () => {
  assert.deepEqual(parseMarkedTools("find, assign,,notify"), ["find", "assign", "notify"]);
  assert.deepEqual(parseMarkedTools(["a,b", "c"]), ["a", "b"]);
  assert.deepEqual(parseMarkedTools(undefined), []);
  assert.equal(parseMarkedTools(Array.from({ length: 12 }, (_, i) => `t${i}`).join(",")).length, 8);
});

const segment = (
  id: string,
  workflowId: string,
  start: [string, number],
  end: [string, number],
) => ({
  id,
  workflowId,
  startTurnId: start[0],
  startOrdinal: start[1],
  endTurnId: end[0],
  endOrdinal: end[1],
});

test("a band crosses turns: it covers its steps from the first turn to the last, model calls between them too", () => {
  const steps = [
    { turnId: "t1", ordinal: 1 },
    { turnId: "t1", ordinal: null },
    { turnId: "t1", ordinal: 2 },
    { turnId: "t2", ordinal: 1 },
    { turnId: "t2", ordinal: 2 },
    { turnId: "t3", ordinal: 1 },
  ];
  assert.deepEqual(segmentBands(steps, [segment("s1", "book", ["t1", 2], ["t2", 2])]), [
    { segmentId: "s1", workflowId: "book", first: 2, last: 4 },
  ]);
});

test("two bands inside one trace split its turn at the second task's first step", () => {
  const steps = [
    { turnId: "t1", ordinal: 1 },
    { turnId: "t1", ordinal: 2 },
    { turnId: "t1", ordinal: null },
    { turnId: "t1", ordinal: 3 },
    { turnId: "t1", ordinal: 4 },
  ];
  const bands = segmentBands(steps, [
    segment("s2", "refund", ["t1", 3], ["t1", 4]),
    segment("s1", "book", ["t1", 1], ["t1", 2]),
  ]);
  assert.deepEqual(bands, [
    { segmentId: "s1", workflowId: "book", first: 0, last: 2 },
    { segmentId: "s2", workflowId: "refund", first: 3, last: 4 },
  ]);
});

test("a band with no step left in the session is dropped", () => {
  assert.deepEqual(
    segmentBands([{ turnId: "t1", ordinal: 1 }], [segment("s1", "book", ["gone", 1], ["gone", 3])]),
    [],
  );
});

test("typed steps read by kind: model call, code, handoff and user message keep engine names out", () => {
  const base = {
    ordinal: 1,
    kind: "model_call",
    targetType: null,
    targetId: "gpt-x",
    outcome: "ok",
    tookMs: 40,
    hitCount: null,
  };
  assert.deepEqual(sessionStep(base, {}, { typedSteps: true }), {
    key: 1,
    kind: "model_call",
    toolId: null,
    label: "Model call",
    title: "Model call, 40 ms",
    failed: false,
  });
  assert.equal(
    sessionStep({ ...base, kind: "code", targetId: "load_cart" }, {}, { typedSteps: true }).label,
    "Load cart",
  );
  assert.equal(
    sessionStep(
      { ...base, kind: "handoff", targetId: "billing_agent", outcome: "error" },
      {},
      { typedSteps: true },
    ).title,
    "Handoff to billing agent, 40 ms, failed",
  );
  assert.equal(
    sessionStep({ ...base, kind: "user_message", tookMs: null }, {}, { typedSteps: true }).label,
    "User message",
  );
  assert.equal(
    sessionStep({ ...base, kind: "model_call" }, {}).kind,
    "search",
    "flag off keeps today's reading",
  );
});
