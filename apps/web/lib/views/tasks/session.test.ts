import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkedTools, sessionStep } from "@/lib/views/tasks/session";

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
