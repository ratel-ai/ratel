import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { TaskEvalsSection } from "@/components/console/evals/TaskEvalsSection";
import type { EvalRun } from "@/lib/views/evals/domain/types";
import type { TaskEvalRow } from "@/lib/views/evals/page";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";

const AT = new Date("2026-11-08T09:10:00Z");
const ROWS: TaskEvalRow[] = [
  {
    id: "e1",
    name: "Flight cancelled, rebook",
    suggested: false,
    tasks: [],
    checks: 3,
    last6: [],
    last: "fail",
    change: "now_fails",
  },
  {
    id: "e2",
    name: "Where is my refund?",
    suggested: true,
    tasks: [],
    checks: 1,
    last6: [],
    last: "pass",
    change: "fixed",
  },
  {
    id: "e3",
    name: "Seat swap",
    suggested: true,
    tasks: [],
    checks: 2,
    last6: [],
    last: null,
    change: null,
  },
];
const QUEUED: EvalRun = {
  id: "33333333-3333-4333-8333-333333333333",
  projectId: PROJECT_ID,
  kind: "manual",
  fixId: null,
  suite: "Task wf-1",
  status: "queued",
  spend: { usd: 0, reservedUsd: 0, reserved: false },
  evalCount: 3,
  error: null,
  createdBy: "u",
  createdAt: AT,
  startedAt: null,
  finishedAt: null,
};
const section = (rows: TaskEvalRow[], live: EvalRun | null) =>
  render(createElement(TaskEvalsSection, { projectId: PROJECT_ID, taskId: "wf 1", rows, live }));

test("with evals: each eval with its Suggested label, checks, last result and change; Run this task's evals and See all on Evals", () => {
  const html = section(ROWS, null);
  const text = visibleText(html);
  for (const word of [
    "Evals",
    "Flight cancelled, rebook",
    "Where is my refund?",
    "3 built-in",
    "1 built-in",
    "Fails",
    "Passes",
    "Not run yet",
    "Now fails",
    "Fixed",
    "Run this task",
    "See all on Evals",
  ])
    assert.ok(text.includes(word), word);
  assert.equal(text.match(/Suggested/g)?.length, 2);
  assert.ok(text.includes("3 evals · 2 suggested from this task"));
  assert.match(html, new RegExp(`href="/project/${PROJECT_ID}/evals\\?task=wf(\\+|%20)1"`));
  assert.doesNotMatch(html, /<button[^>]* disabled=""[^>]*>Run this task/);
  assert.doesNotMatch(text, /Approve|Dismiss|Run queued/);
});

test("with no evals: an empty state, and the run button is off", () => {
  const html = section([], null);
  assert.match(visibleText(html), /No evals test this task yet/);
  assert.match(html, /<button[^>]* disabled=""[^>]*>Run this task/);
  const none = visibleText(
    section(
      ROWS.map((row) => ({ ...row, suggested: false })),
      null,
    ),
  );
  assert.ok(none.includes("3 evals"));
  assert.doesNotMatch(none, /suggested from this task/);
});

test("while a run is queued: it says so, links the run, and the button is off", () => {
  const html = section(ROWS, QUEUED);
  const text = visibleText(html);
  assert.match(text, /Run queued/);
  assert.match(text, /3 evals run against the agent as recorded/);
  assert.match(html, new RegExp(`/project/${PROJECT_ID}/evals/runs/${QUEUED.id}`));
  assert.match(html, /<button[^>]* disabled=""[^>]*>Run this task/);
  assert.match(visibleText(section(ROWS, { ...QUEUED, status: "running" })), /Running/);
});

test("RC-616, RC-658: a score-based suggestion names its scorer, its score and the pass threshold", () => {
  const reason = { scorerId: "s1", scorerName: "Answer quality", value: 0.2, threshold: 0.7 };
  const text = visibleText(section([{ ...ROWS[1]!, reason }, ROWS[2]!], null));
  assert.ok(
    text.includes("Answer quality: 20%, passes at 70%"),
    "RC-658: one unit, the percent of the scorer page.",
  );
  assert.equal(text.match(/passes at/g)?.length, 1, "A suggestion with no reason shows none.");
});
