import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fix } from "@/lib/views/fixes/types";
import {
  type SelfCorrectionsCardModel,
  unavailableSelfCorrectionsCard,
} from "@/lib/views/health/self-corrections/card";
import {
  descriptionsHref,
  type FixesSlice,
  fixesGlance,
  type IntentsRead,
  intentsGlance,
  READ_FAILED,
  selfCorrectionsGlance,
  tasksGlance,
} from "@/lib/views/home/glance";
import type { TaskListModel, TaskRow } from "@/lib/views/tasks/model";

const P = "p1";

const INTENTS: IntentsRead = {
  topics: [
    { id: "t_schedule", turns: 258, answered: 250 },
    { id: "t_rental", turns: 55, answered: 0 },
    { id: "t_inspect", turns: 53, answered: 10 },
    { id: "t_gone", turns: 400, answered: 400 },
  ],
  // "t_gone" has no stored intent: Intents does not list it, so neither does the tile.
  names: new Map([
    ["t_schedule", "Schedule status"],
    ["t_rental", "Equipment rental"],
    ["t_inspect", "Inspection scheduling"],
  ]),
};

test("intents: how many, the busiest as a pin, and the ones left unanswered", () => {
  const glance = intentsGlance(P, INTENTS);
  assert.equal(glance.state, "ready");
  assert.equal(glance.href, "/project/p1/intents");
  assert.equal(glance.count, 3);
  assert.deepEqual(glance.top, {
    id: "t_schedule",
    name: "Schedule status",
    href: "/project/p1/intents?peek=t_schedule",
  });
  assert.deepEqual(
    glance.unanswered.map((intent) => [intent.id, intent.unanswered, intent.answeredShare]),
    [
      ["t_rental", 55, 0],
      ["t_inspect", 43, 10 / 53],
    ],
  );
});

test("intents before a reading, after a failed read, and with nothing asked", () => {
  assert.deepEqual(intentsGlance(P, null), {
    state: "none",
    href: "/project/p1/intents",
    count: 0,
    top: null,
    unanswered: [],
  });
  assert.equal(intentsGlance(P, READ_FAILED).state, "failed");
  const quiet = intentsGlance(P, {
    topics: [{ id: "t", turns: 0, answered: 0 }],
    names: new Map([["t", "Quiet"]]),
  });
  assert.equal(quiet.count, 1);
  assert.equal(quiet.top, null, "an intent nobody asked is no top intent");
});

function row(
  id: string,
  runs: number,
  finishRate: number | null,
  color: TaskRow["color"] = null,
): TaskRow {
  return {
    id,
    name: `Task ${id}`,
    description: null,
    icon: "workflow",
    color,
    status: "healthy",
    runs,
    share: null,
    finishRate,
    weakest: null,
    correctionsPer100: null,
    topics: null,
    issues: 0,
    fixes: 0,
    fixesHref: "",
  };
}

function list(rows: TaskRow[], overrides: Partial<TaskListModel> = {}): TaskListModel {
  return {
    state: "ready",
    blocked: null,
    windowDays: 30,
    readAt: null,
    stats: {
      tasks: rows.length,
      runsInTasks: 0,
      allRuns: 0,
      finishRate: 0.95,
      correctionsPer100: null,
      correctionsRecorded: false,
    },
    rows,
    unserved: { measured: false, asks: [], runs: 0 },
    readingSince: null,
    excludedRuns: 0,
    ...overrides,
  };
}

test("tasks: the finish rate as Tasks reads it, and the task that finishes least as a pin", () => {
  const glance = tasksGlance(P, {
    list: list([
      row("a", 218, 0.876, "chart-1"),
      row("b", 124, 1),
      row("c", 4, 0.5),
      row("d", 101, 0.95, "chart-4"),
    ]),
    steps: [["x", "y"]],
  });
  assert.equal(glance.state, "ready");
  assert.equal(glance.href, "/project/p1/health/tasks");
  assert.equal(glance.count, 4);
  assert.equal(glance.finishRate, 0.95);
  // c finishes least but on too few runs to say so.
  assert.deepEqual(glance.weakest, {
    id: "a",
    name: "Task a",
    slot: "chart-1",
    href: "/project/p1/health/tasks/a",
    finishRate: 0.876,
  });
  assert.deepEqual(glance.byId.d, {
    id: "d",
    name: "Task d",
    slot: "chart-4",
    href: "/project/p1/health/tasks/d",
  });
  assert.deepEqual(glance.steps, [["x", "y"]]);
});

test("tasks that all finish have no weakest; the states before a reading say why", () => {
  assert.equal(tasksGlance(P, { list: list([row("a", 50, 1)]), steps: [] }).weakest, null);
  assert.equal(tasksGlance(P, null).state, "none");
  assert.equal(
    tasksGlance(P, { list: list([], { state: "no_reading" }), steps: [] }).state,
    "none",
  );
  assert.equal(tasksGlance(P, READ_FAILED).state, "failed");
  const blocked = tasksGlance(P, {
    list: list([], { state: "blocked", blocked: "mixed_runs" }),
    steps: [],
  });
  assert.deepEqual([blocked.state, blocked.blocked], ["blocked", "mixed_runs"]);
});

test("self-corrections read Agent health's card: the rate, its change and the tool after which most happen", () => {
  const card: SelfCorrectionsCardModel = {
    state: "ready",
    windowDays: 7,
    rate: {
      label: "Per 100 turns",
      value: "18.4",
      hint: "",
      delta: { value: "+1.2", direction: "up", good: false, label: "vs the 7 days before" },
    },
    events: 46,
    turns: 250,
    topTool: {
      node: "tool:search_docs",
      entryId: "search_docs",
      entryKind: "tool",
      name: "search_docs",
      events: 20,
      mainKind: "Retried",
      href: "/project/p1/health/self-corrections?tool=search_docs",
    },
    href: "/project/p1/health/self-corrections",
    trend: null,
    recovered: null,
    recoveredShare: null,
    topPhrase: null,
    phrasesCaptured: false,
  };
  assert.deepEqual(selfCorrectionsGlance(card), {
    state: "ready",
    href: "/project/p1/health/self-corrections",
    windowDays: 7,
    value: "18.4",
    delta: { value: "+1.2", direction: "up", good: false, label: "vs the 7 days before" },
    events: 46,
    topTool: "search_docs",
  });
  const failed = selfCorrectionsGlance(unavailableSelfCorrectionsCard(P, 7));
  assert.equal(failed.state, "unavailable");
  assert.equal(failed.topTool, null);
  assert.equal(failed.delta, undefined);
});

test("fixes: how many are ready, and how many description updates Ratel can apply, the count Needs attention shows", () => {
  const fix = (id: string, kind: Fix["kind"], apply = false) =>
    ({ id, kind, actions: { apply } }) as Fix;
  const slice: FixesSlice = {
    open: [
      fix("rewrite:1", "rewrite", true),
      fix("rewrite:2", "rewrite", true),
      fix("craft:2", "rewrite"),
      fix("craft:3", "combine"),
    ],
    applied: [],
    rewritesOn: true,
  };
  assert.deepEqual(fixesGlance(P, slice), {
    state: "ready",
    href: "/project/p1/improvement/fixes",
    open: 4,
    descriptions: 2,
    descriptionsPageHref: "/project/p1/quality/descriptions",
  });
  assert.equal(
    fixesGlance(P, { ...slice, rewritesOn: false }).descriptions,
    0,
    "none to apply when the plan has no rewrites",
  );
  assert.equal(fixesGlance(P, null).state, "failed");
});

test("Quality › Descriptions takes a tool or an open rewrite", () => {
  assert.equal(descriptionsHref(P), "/project/p1/quality/descriptions");
  assert.equal(
    descriptionsHref(P, { tool: "lookup_order" }),
    "/project/p1/quality/descriptions?tool=lookup_order",
  );
  assert.equal(
    descriptionsHref(P, { peek: "rewrite:r1" }),
    "/project/p1/quality/descriptions?peek=rewrite%3Ar1",
  );
});
