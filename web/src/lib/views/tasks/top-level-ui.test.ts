import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { TaskGone } from "@/components/console/tasks/TaskGone";
import { TasksView } from "@/components/console/tasks/TasksView";
import type { TaskListModel, TaskRow } from "@/lib/views/tasks/model";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";

const NOW = new Date("2026-11-01T12:00:00Z");
const ROOT = `/project/${PROJECT_ID}/tasks`;
const ROW: TaskRow = {
  id: "task-a",
  name: "Ship a release",
  description: null,
  icon: "rocket",
  color: "chart-5",
  status: "watch",
  runs: 30,
  share: 1,
  finishRate: 0.8,
  weakest: null,
  correctionsPer100: null,
  topics: null,
  issues: 0,
  fixes: 0,
  fixesHref: "/fixes",
};
const MODEL: TaskListModel = {
  state: "ready",
  blocked: null,
  windowDays: 30,
  readAt: NOW,
  stats: {
    tasks: 2,
    runsInTasks: 40,
    allRuns: 50,
    finishRate: 0.8,
    correctionsPer100: null,
    correctionsRecorded: false,
  },
  rows: [ROW, { ...ROW, id: "task-b", name: "Book an inspection", status: "healthy", runs: 10 }],
  unserved: { measured: false, asks: [], runs: 0 },
  readingSince: null,
  excludedRuns: 0,
};

test("top-level Tasks shows one row per task with its status", () => {
  const html = render(
    createElement(TasksView, {
      projectId: PROJECT_ID,
      model: MODEL,
      now: NOW,
      topLevel: true,
    }),
  );
  assert.deepEqual(
    [...html.matchAll(/data-task-row="([^"]+)"/g)].map((match) => match[1]),
    ["task-a", "task-b"],
  );
  assert.match(html, new RegExp(`href="${ROOT}/task-a"`));
  assert.match(html, /data-task-status="watch"/);
  assert.match(html, /data-task-status="healthy"/);
  assert.doesNotMatch(html, /Agent health<\/a>|data-task-row="unserved"/);
});

test("top-level Tasks shows no score of the old task scoring, and its empty state", () => {
  const base = { projectId: PROJECT_ID, model: MODEL, now: NOW, topLevel: true };
  const disabled = render(createElement(TasksView, base));
  assert.doesNotMatch(visibleText(disabled), /Live score|14 days|Not scored/);
  const empty = render(
    createElement(TasksView, { ...base, model: { ...MODEL, state: "no_reading", rows: [] } }),
  );
  assert.match(visibleText(empty), /No tasks yet/);
  assert.doesNotMatch(empty, /<table/);
});

test("a missing top-level task links back to the top-level list", () => {
  const html = render(
    createElement(TaskGone, { projectId: PROJECT_ID, known: true, reading: true, listHref: ROOT }),
  );
  assert.match(html, new RegExp(`href="${ROOT}"`));
  assert.doesNotMatch(html, /\/health\/tasks|Agent health<\/a>/);
});
