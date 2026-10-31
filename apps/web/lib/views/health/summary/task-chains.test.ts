import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beforeHint,
  chainShareText,
  EVERY_CALL_HINT,
  LANE_HINT,
  LANE_LABEL,
  VIEW_LABELS,
} from "@/components/console/health/v2/call-order-copy";
import type { JourneyChain } from "@/lib/readings/trace-signals/flow-journey-insights";
import {
  type ChainTaskInput,
  chainsAsTasks,
  TASK_CHAINS_SHOWN,
} from "@/lib/views/health/summary/task-chains";

/**
 * Common chains are named by their task, and only chains that are a task
 * are shown: no raw tool lists (round 3, B10). The call order's words: its
 * two views in plain words, each with one line on hover, and its lane.
 */

function chain(tools: string[], turns: number): JourneyChain {
  return { tools, labels: tools, turns, share: turns / 1_000, score: turns * (tools.length - 1) };
}

const TASKS: ChainTaskInput[] = [
  {
    id: "wf-po",
    name: "Track material delivery status",
    color: "chart-1",
    tools: ["list_projects", "get_purchase_order", "track_material_delivery"],
  },
  {
    id: "wf-spec",
    name: "Look up a spec requirement",
    color: "chart-5",
    tools: ["get_project_info", "search_spec_book"],
  },
  {
    id: "wf-comment",
    name: "Update a task and comment",
    color: null,
    tools: ["update_task", "add_task_comment"],
  },
  { id: "wf-quiet", name: "Never chained", color: null, tools: ["a", "b"] },
  { id: "wf-one", name: "One step", color: null, tools: ["solo"] },
];

test("only chains that are a task, named by it, most turns first; a sub-chain or a raw list is dropped", () => {
  const rows = chainsAsTasks(
    [
      chain(["get_purchase_order", "track_material_delivery"], 223),
      chain(["list_projects", "get_purchase_order", "track_material_delivery"], 146),
      chain(["get_project_info", "search_spec_book"], 124),
      chain(["list_rfis", "get_rfi"], 77),
    ],
    TASKS,
    "p1",
  );
  assert.deepEqual(
    rows.map((row) => [row.task.name, row.chain.turns, row.inOrder]),
    [
      ["Track material delivery status", 146, true],
      ["Look up a spec requirement", 124, true],
    ],
  );
  assert.deepEqual(rows[0]!.task, {
    id: "wf-po",
    name: "Track material delivery status",
    color: "chart-1",
    href: "/project/p1/health/tasks/wf-po",
  });
});

test("a task run the other way round is still the task; its own order wins when both repeat", () => {
  const reversed = chainsAsTasks([chain(["add_task_comment", "update_task"], 54)], TASKS, "p1");
  assert.deepEqual(
    reversed.map((row) => [row.task.id, row.chain.turns, row.inOrder]),
    [["wf-comment", 54, false]],
  );
  const both = chainsAsTasks(
    [
      chain(["add_task_comment", "update_task"], 90),
      chain(["update_task", "add_task_comment"], 78),
    ],
    TASKS,
    "p1",
  );
  assert.deepEqual(
    both.map((row) => [row.task.id, row.chain.turns, row.inOrder]),
    [["wf-comment", 78, true]],
    "one row per task",
  );
  assert.deepEqual(
    chainsAsTasks([chain(["update_task", "add_task_comment", "update_task"], 40)], TASKS, "p1"),
    [],
    "a repeat inside is not the task",
  );
});

test("none is a task: nothing to show, so the section is dropped", () => {
  assert.deepEqual(chainsAsTasks([chain(["x", "y"], 300)], TASKS, "p1"), []);
  assert.deepEqual(chainsAsTasks([], TASKS, "p1"), []);
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: `wf-${i}`,
    name: `Task ${i}`,
    color: null,
    tools: [`a${i}`, `b${i}`],
  }));
  assert.equal(
    chainsAsTasks(
      many.map((task, i) => chain([...task.tools], 100 - i)),
      many,
      "p1",
    ).length,
    TASK_CHAINS_SHOWN,
  );
});

test("the call order in plain words: two views with a hover each, and the lane it was read from", () => {
  assert.deepEqual(VIEW_LABELS, { needs: "What comes before", all: "Every call" });
  assert.equal(
    beforeHint(10),
    "Each tool that almost always follows another within 10 minutes, with the tool it follows.",
  );
  assert.equal(
    beforeHint(1),
    "Each tool that almost always follows another within 1 minute, with the tool it follows.",
  );
  assert.equal(
    beforeHint(null),
    "Each tool that almost always follows another, with the tool it follows.",
  );
  assert.equal(EVERY_CALL_HINT, "Every turn, call by call, left to right.");
  assert.deepEqual(LANE_LABEL, {
    otel: "OpenTelemetry",
    sdk: "Ratel SDK",
    mixed: "OpenTelemetry and Ratel SDK",
  });
  assert.match(
    LANE_HINT.otel,
    /Searches arrive only through the Ratel SDK/,
    "OpenTelemetry says exactly why no search marks",
  );
  assert.equal(chainShareText(0.104), "10%");
  assert.equal(chainShareText(0.004), "<1%");
  for (const text of [
    ...Object.values(VIEW_LABELS),
    ...Object.values(LANE_HINT),
    EVERY_CALL_HINT,
    beforeHint(10),
  ]) {
    assert.doesNotMatch(text, /—|Needs first|\btopics?\b/i);
  }
});
