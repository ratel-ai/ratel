import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogHref,
  fixesHref,
  parseFilters,
  selfCorrectionsHref,
  taskHref,
  topicHref,
} from "@/lib/views/health/self-corrections/paths";

test("the page's own link drops the default window and empty filters", () => {
  assert.equal(selfCorrectionsHref("p 1"), "/project/p%201/health/self-corrections");
  assert.equal(selfCorrectionsHref("p1", { days: 7 }), "/project/p1/health/self-corrections");
  assert.equal(
    selfCorrectionsHref("p1", { days: 30, filters: { tool: "skill:triage" } }),
    "/project/p1/health/self-corrections?days=30&tool=skill%3Atriage",
  );
});

test("the neighbours: a task, a topic, Fixes and Catalog", () => {
  assert.equal(taskHref("p1", "wf/1"), "/project/p1/health/tasks/wf%2F1");
  assert.equal(topicHref("p1", "t-1"), "/project/p1/intents?peek=t-1");
  assert.equal(
    fixesHref("p1", { tool: "update_task" }),
    "/project/p1/improvement/fixes?tool=update_task",
  );
  assert.equal(
    fixesHref("p1", { task: "wf-1", topic: "t-1" }),
    "/project/p1/improvement/fixes?task=wf-1&topic=t-1",
  );
  assert.equal(fixesHref("p1"), "/project/p1/improvement/fixes");
  assert.equal(
    catalogHref("p1", "update_task"),
    "/project/p1/catalogs/tools?q=update_task&highlight=update_task",
  );
  assert.equal(catalogHref("p1", "skill:triage"), "/project/p1/catalogs/skills?skill=triage");
});

test("filters from the URL: trimmed, first of repeats, blanks and oversized values ignored", () => {
  assert.deepEqual(parseFilters({ tool: " update_task ", task: ["wf-1", "wf-2"], topic: "" }), {
    tool: "update_task",
    task: "wf-1",
    topic: null,
  });
  assert.deepEqual(parseFilters({ tool: "x".repeat(201) }), {
    tool: null,
    task: null,
    topic: null,
  });
  assert.deepEqual(parseFilters({}), { tool: null, task: null, topic: null });
});
