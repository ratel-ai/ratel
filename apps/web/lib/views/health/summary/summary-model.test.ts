import assert from "node:assert/strict";
import { test } from "node:test";
import {
  peekedReading,
  readingViews,
  tileReading,
} from "@/components/console/health/v2/reading-views";
import { stats as correctionStats } from "@/components/console/health/v2/SelfCorrectionsRow";
import { menuLabel } from "@/components/console/health/v2/SummaryMenu";
import { nudgeShown, nudgeTitle } from "@/components/console/health/v2/setup-nudge";
import { CAPTURE_GUIDE, peekedSetup, setupPeek } from "@/components/console/health/v2/setup-peek";
import {
  fixLookups,
  sourceWords,
  summaryDescription,
  summaryState,
  taskLookups,
  tasksNeedingLook,
} from "@/components/console/health/v2/summary-model";
import type { HealthTile, WorkflowRowView } from "@/lib/readings/trace-signals/view";
import type { Fix } from "@/lib/views/fixes/types";
import type { SelfCorrectionsCardModel } from "@/lib/views/health/self-corrections/card";
import type { TaskListModel, TaskRow } from "@/lib/views/tasks/model";

const DAYS = [
  "2026-10-15",
  "2026-10-16",
  "2026-10-17",
  "2026-10-18",
  "2026-10-19",
  "2026-10-20",
  "2026-10-21",
];

function tile(key: HealthTile["key"], over: Partial<HealthTile> = {}): HealthTile {
  return {
    key,
    label: key,
    value: 0.5,
    unit: "share",
    interval: { low: 0.41, high: 0.62 },
    sub: "Counted over 40 runs.",
    tier: "deterministic",
    upIsGood: true,
    delta: 0.04,
    series: DAYS.map((day, index) => ({ day, value: index === 2 ? null : 0.5 })),
    n: 40,
    ...over,
  };
}

function card(over: Partial<SelfCorrectionsCardModel> = {}): SelfCorrectionsCardModel {
  return {
    state: "ready",
    windowDays: 7,
    rate: {
      label: "Per 100 turns",
      value: "19.4",
      hint: "21.1 in the 7 days before",
      delta: { value: "-1.7", direction: "down", good: true, label: "vs the 7 days before" },
    },
    events: 58,
    turns: 298,
    topTool: null,
    href: "/project/p1/health/self-corrections?days=7",
    trend: {
      values: [12, null, 20.5, 19, 18, 22, 19.4],
      bucketDays: 1,
      label: "Per 100 turns, day by day",
    },
    recovered: { label: "Recovered", value: "68%", hint: "25 of 37 failed calls" },
    recoveredShare: 25 / 37,
    topPhrase: { phrase: "I'm sorry", events: 6 },
    phrasesCaptured: true,
    ...over,
  };
}

test("the readings in plain words, each with its change, five at most; self-corrections have their own row", () => {
  const otel = [
    tile("completed"),
    tile("failed_calls", { upIsGood: false }),
    tile("wasted_calls", {
      unit: "per_100_turns",
      value: 5.7,
      delta: 1.6,
      upIsGood: false,
      interval: null,
    }),
    tile("round_trips", { unit: "per_turn", value: 2.7, delta: 0 }),
  ];
  const views = readingViews(otel);
  assert.deepEqual(
    views.map((view) => view.label),
    ["Finish rate", "Failed calls", "Wasted calls per 100 turns", "Model calls per run"],
  );
  assert.deepEqual(views[0]!.delta, {
    value: "+4 pts",
    direction: "up",
    good: true,
    label: "vs the window before",
  });
  assert.deepEqual(
    views[1]!.delta,
    { value: "+4 pts", direction: "up", good: false, label: "vs the window before" },
    "more failed calls is worse",
  );
  assert.equal(views[3]!.delta?.direction, "flat");
  assert.equal(views[2]!.value, "5.7");
  assert.equal(views[0]!.range, "41 to 62%");
  assert.equal(views[0]!.trend?.[2], null, "a day without a reading stays a gap");
  assert.equal(views.length, 4);
  assert.equal(
    readingViews([...otel, tile("first_try"), tile("detours")]).length,
    5,
    "never more than a StatRow takes",
  );

  const sdk = readingViews([
    tile("first_try"),
    tile("detours"),
    tile("junk"),
    tile("wasted_calls"),
  ]);
  assert.deepEqual(sdk.map((view) => view.label).slice(0, 3), [
    "First try",
    "Detours",
    "Junk in lists",
  ]);
});

test("a reading without a value is a dash, with no change and no days drawn", () => {
  const empty = tileReading(
    tile("first_try", {
      value: null,
      delta: null,
      interval: null,
      sub: "Waiting for enough turns.",
    }),
  );
  assert.equal(empty.value, "–");
  assert.equal(empty.delta, null);
  assert.equal(empty.trend, null);
  assert.equal(empty.range, null);
  assert.equal(empty.hint, "Waiting for enough turns.");
});

test("the self-corrections row: rate with its trend, recovered, the tool most corrected after as a pin, the top phrase", () => {
  const top = {
    node: "skill:triage",
    entryId: "triage",
    entryKind: "skill" as const,
    name: "Triage",
    events: 32,
    mainKind: "Switched tools",
    href: "/project/p1/health/self-corrections?tool=skill%3Atriage",
  };
  const [rate, recovered, after, phrase] = correctionStats(card({ topTool: top }));
  assert.equal(rate!.label, "Per 100 turns");
  assert.equal(rate!.value, "19.4");
  assert.equal(rate!.delta?.good, true, "fewer is good news");
  assert.equal(rate!.href, "/project/p1/health/self-corrections?days=7");
  assert.ok(rate!.trend, "its trend under it");
  assert.deepEqual([recovered!.label, recovered!.value], ["Recovered", "68%"]);
  assert.equal(after!.label, "Most after");
  assert.equal(after!.hint, "32 times");
  assert.deepEqual([phrase!.label, phrase!.hint], ["Top phrase", "6 times"]);

  // Each says what it needs when it has nothing.
  const bare = correctionStats(
    card({
      trend: null,
      recovered: { label: "Recovered", value: "No errors", hint: "" },
      recoveredShare: null,
      topPhrase: null,
      phrasesCaptured: false,
    }),
  );
  assert.equal(bare[0]!.trend, undefined);
  assert.equal(bare[1]!.hint, "No tool call failed");
  assert.deepEqual([bare[2]!.value, bare[2]!.hint], ["–", "No tool call before them"]);
  assert.deepEqual(
    [bare[3]!.value, bare[3]!.hint],
    ["–", "Needs content capture"],
    "the SDK lane without captured replies says so",
  );
  assert.equal(correctionStats(card({ topPhrase: null }))[3]!.hint, "Said nothing to take back");
  assert.equal(peekedReading("reading:first_try"), "first_try");
  assert.equal(peekedReading("issue:a"), null);
});

test("the line under the title: the project, the window, and the lane the reading came from", () => {
  assert.equal(
    summaryDescription({
      projectName: "Site Copilot",
      windowDays: 7,
      turns: 1436,
      sourceMode: "otel",
      reading: true,
    }),
    "What Site Copilot gets wrong this week, from 1,436 turns through OpenTelemetry.",
  );
  assert.equal(
    summaryDescription({
      projectName: "Acme",
      windowDays: 30,
      turns: 1,
      sourceMode: "mixed",
      reading: true,
    }),
    "What Acme gets wrong in the last 30 days, from 1 turn through the Ratel SDK and OpenTelemetry.",
  );
  assert.equal(
    summaryDescription({
      projectName: "Demo",
      windowDays: 7,
      turns: 0,
      sourceMode: "sdk",
      reading: false,
    }),
    "What Demo gets wrong this week, read from its own traces.",
  );
  assert.equal(sourceWords("sdk"), "the Ratel SDK");
});

test("without a decided state the model alone says which state the page is in", () => {
  const decided = { kind: "unavailable" } as const;
  assert.equal(summaryState(decided, { turns: 500, floor: 50 }), decided);
  assert.deepEqual(summaryState(null, { turns: 500, floor: 50 }), { kind: "ready" });
  assert.deepEqual(summaryState(null, { turns: 12, floor: 50 }), {
    kind: "too_few",
    turns: 12,
    floor: 50,
    imported: false,
    wider: null,
  });
  assert.deepEqual(summaryState(null, { turns: 0, floor: 50, waitingOn: "tool_spans" }), {
    kind: "tool_spans",
  });
  assert.deepEqual(summaryState(null, { turns: 0, floor: 50 }), { kind: "nothing_yet" });
});

function row(id: string, status: TaskRow["status"], runs: number): TaskRow {
  return {
    id,
    name: id,
    description: null,
    icon: "workflow",
    color: null,
    status,
    runs,
    share: null,
    finishRate: 0.9,
    weakest: null,
    correctionsPer100: null,
    topics: null,
    issues: 0,
    fixes: 0,
    fixesHref: "/",
  } as TaskRow;
}

test("tasks that need a look: failing, then slow, then watch, busiest first in each; never a healthy one", () => {
  const rows = [
    row("ok", "healthy", 900),
    row("w-small", "watch", 10),
    row("slow", "slow", 5),
    row("w-big", "watch", 80),
    row("fail", "failing", 3),
  ];
  assert.deepEqual(
    tasksNeedingLook(rows).map((each) => each.id),
    ["fail", "slow", "w-big", "w-small"],
  );
  assert.equal(tasksNeedingLook(rows, 2).length, 2);
  assert.deepEqual(tasksNeedingLook([row("ok", "healthy", 1)]), []);
});

test("a task's name and color come from the task list, its steps from the reading", () => {
  const items = [
    { id: "wf-a", name: "reading name", focusTools: ["x", "y"], runs: 10 },
  ] as unknown as WorkflowRowView[];
  const tasks = {
    rows: [{ ...row("wf-a", "watch", 40), name: "Ship a release", color: "chart-1" }],
  } as unknown as TaskListModel;
  assert.deepEqual(taskLookups(tasks, { items }), [
    { id: "wf-a", name: "Ship a release", color: "chart-1", tools: ["x", "y"], runs: 40 },
  ]);
  assert.deepEqual(
    taskLookups(null, { items }),
    [{ id: "wf-a", name: "reading name", color: null, tools: ["x", "y"], runs: 10 }],
    "without the list: no color",
  );
  assert.deepEqual(taskLookups(tasks, null), []);
  const fix = {
    id: "craft:1",
    aliases: ["issue:a"],
    title: "Do it",
    status: "open",
    kind: "rewrite",
    source: "craft",
    subject: { tools: [{ id: "create_task" }], tasks: [], topics: [] },
  } as unknown as Fix;
  assert.deepEqual(fixLookups({ open: [fix], applied: [] }), [
    {
      id: "craft:1",
      aliases: ["issue:a"],
      title: "Do it",
      status: "open",
      kind: "rewrite",
      source: "craft",
      toolIds: ["create_task"],
    },
  ]);
  assert.equal(fixLookups(null), null);
});

test("setup guides open by key from the URL; an unknown key opens nothing", () => {
  assert.equal(setupPeek("sdk_turn_ids"), "setup:sdk_turn_ids");
  assert.equal(peekedSetup("setup:sdk_turn_ids"), "sdk_turn_ids");
  assert.equal(peekedSetup(`setup:${CAPTURE_GUIDE}`), CAPTURE_GUIDE);
  assert.equal(peekedSetup("setup:no_such_thing"), null);
  assert.equal(peekedSetup("issue:a"), null);
});

test("the older capture nudge, in the product's words", () => {
  const unlocks = [
    { key: "a", label: "A", description: "a" },
    { key: "b", label: "B", description: "b" },
  ];
  assert.equal(
    nudgeTitle({ unlocks, captureLevel: "tools", mode: "sdk" }),
    "Turn on content capture to see 2 more kinds of issues",
  );
  assert.equal(
    nudgeTitle({ unlocks, captureLevel: "content", mode: "otel" }),
    "Turn on 2 more OpenTelemetry options to see more",
  );
  assert.equal(
    nudgeShown({ unlocks, captureLevel: "content", mode: "sdk" }),
    false,
    "content already captured",
  );
  assert.equal(nudgeShown({ unlocks: [], captureLevel: "tools", mode: "sdk" }), false);
  assert.equal(nudgeShown(null), false);
});

test("the header menu is named for what it holds", () => {
  // Owned: the menu holds the report alone in this edition (no importer, no share link).
  assert.equal(menuLabel({ report: true }), "Download");
  assert.equal(menuLabel({ report: false }), "");
});
