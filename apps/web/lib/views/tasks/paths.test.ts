import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogToolHref,
  descriptionsHref,
  fixesHref,
  healthIssueHref,
  issuePeek,
  legacyAskId,
  legacyToolCraftTarget,
  parseTaskPeek,
  selfCorrectionsHref,
  stepPeek,
  taskHref,
  taskPeekHref,
  taskSessionHref,
  tasksHref,
  topicHref,
} from "@/lib/views/tasks/paths";

const P = "11111111-1111-4111-8111-111111111111";

test("task pages and their neighbours", () => {
  assert.equal(tasksHref(P), `/project/${P}/health/tasks`);
  assert.equal(tasksHref(P, { peek: "unserved" }), `/project/${P}/health/tasks?peek=unserved`);
  assert.equal(taskHref(P, "720ed5a8798e3925"), `/project/${P}/health/tasks/720ed5a8798e3925`);
  assert.equal(
    taskSessionHref(P, "s 1", { tools: ["a", "b"], task: "t1" }),
    `/project/${P}/health/tasks/sessions/s%201?tools=a%2Cb&task=t1`,
  );
  assert.equal(
    selfCorrectionsHref(P, { task: "t1" }),
    `/project/${P}/health/self-corrections?task=t1`,
  );
  assert.equal(fixesHref(P, { task: "t1" }), `/project/${P}/improvement/fixes?task=t1`);
  assert.equal(fixesHref(P, { peek: "fix-1" }), `/project/${P}/improvement/fixes?peek=fix-1`);
  assert.equal(topicHref(P, "topic-7"), `/project/${P}/intents?peek=topic-7`);
});

test("old Tool craft links land on Tasks, an open ask on its task when one is found, suggestions on Fixes", () => {
  assert.equal(legacyToolCraftTarget(P, {}, null), tasksHref(P));
  assert.equal(legacyToolCraftTarget(P, { scope: "session" }, null), tasksHref(P));
  assert.equal(legacyToolCraftTarget(P, { ask: "a1b2" }, "task-9"), taskHref(P, "task-9"));
  assert.equal(
    legacyToolCraftTarget(P, { peek: "a1b2" }, "task-9"),
    taskHref(P, "task-9"),
    "the v2 Asks tab's open row",
  );
  assert.equal(
    legacyToolCraftTarget(P, { ask: "a1b2" }, null),
    tasksHref(P),
    "no task runs those tools",
  );
  assert.equal(legacyToolCraftTarget(P, { view: "crafts", ask: "a1b2" }, "task-9"), fixesHref(P));
  assert.equal(legacyToolCraftTarget(P, { view: "patterns" }, null), tasksHref(P));
});

test("only well-formed ask ids are read", () => {
  assert.equal(
    legacyAskId({ ask: "0b6f6c8e-1d2a-4c55-9a4e-2f2a2f2a2f2a" }),
    "0b6f6c8e-1d2a-4c55-9a4e-2f2a2f2a2f2a",
  );
  assert.equal(legacyAskId({ ask: ["first", "second"] }), "first");
  assert.equal(legacyAskId({ ask: "drop table; --" }), null);
  assert.equal(legacyAskId({}), null);
});

test("a task's panels live in the URL: a step or an issue", () => {
  assert.equal(
    taskPeekHref(P, "wf-1", stepPeek("track_delivery")),
    `/project/${P}/health/tasks/wf-1?peek=step%3Atrack_delivery`,
  );
  assert.deepEqual(parseTaskPeek(stepPeek("skill:triage")), { kind: "step", id: "skill:triage" });
  assert.deepEqual(parseTaskPeek(issuePeek("sig-1")), { kind: "issue", id: "sig-1" });
  assert.equal(parseTaskPeek("step:"), null);
  assert.equal(parseTaskPeek("unserved"), null);
  assert.equal(parseTaskPeek(null), null);
});

test("the neighbours a task's page links to by contract", () => {
  assert.equal(
    descriptionsHref(P, { tool: "lookup" }),
    `/project/${P}/quality/descriptions?tool=lookup`,
  );
  assert.equal(
    descriptionsHref(P, { tool: "lookup", peek: "rewrite:mq-1" }),
    `/project/${P}/quality/descriptions?peek=rewrite%3Amq-1`,
    "a drafted rewrite wins",
  );
  assert.equal(
    catalogToolHref(P, "lookup"),
    `/project/${P}/catalogs/tools?q=lookup&highlight=lookup`,
  );
  assert.equal(catalogToolHref(P, "skill:triage"), `/project/${P}/catalogs/skills?skill=triage`);
  assert.equal(healthIssueHref(P, "sig-1"), `/project/${P}/health?peek=issue%3Asig-1`);
  assert.equal(
    selfCorrectionsHref(P, { tool: "lookup", task: "wf-1" }),
    `/project/${P}/health/self-corrections?tool=lookup&task=wf-1`,
  );
});
