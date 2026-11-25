import assert from "node:assert/strict";
import { test } from "node:test";
import { menuLabel } from "@/components/console/health/v2/SummaryMenu";
import { nudgeShown, nudgeTitle } from "@/components/console/health/v2/setup-nudge";
import { CAPTURE_GUIDE, peekedSetup, setupPeek } from "@/components/console/health/v2/setup-peek";
import {
  fixLookups,
  sourceWords,
  summaryDescription,
  summaryState,
  taskLookups,
} from "@/components/console/health/v2/summary-model";
import type { WorkflowRowView } from "@/lib/readings/trace-signals/view";
import type { Fix } from "@/lib/views/fixes/types";
import type { TaskListModel, TaskRow } from "@/lib/views/tasks/model";

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
  // Owned: the importer and the share dialog are the edition's, absent without one.
  assert.equal(
    menuLabel({ canImport: true, report: true, share: true }),
    "Import, download and share",
  );
  assert.equal(menuLabel({ canImport: false, report: true, share: true }), "Download and share");
  assert.equal(menuLabel({ canImport: false, report: false, share: true }), "Share");
  assert.equal(menuLabel({ canImport: false, report: true }), "Download");
  assert.equal(menuLabel({ canImport: true, report: true }), "Import and download");
  assert.equal(menuLabel({ canImport: true, report: false }), "Import");
  assert.equal(menuLabel({ canImport: false, report: false }), "");
});
