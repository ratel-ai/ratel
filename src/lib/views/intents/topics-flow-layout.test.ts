import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowStats } from "@/lib/readings/topics/types";
import {
  askOrdinal,
  bandPath,
  FLOW_GEOMETRY,
  flowNeighbourhood,
  layoutFlow,
} from "@/lib/views/intents/topics-flow-layout";

const TOPICS = new Map([
  ["t_pay", { name: "Payment status", slot: "chart-1" as const }],
  ["t_delivery", { name: "Material delivery", slot: null }],
]);

const FLOW: FlowStats = {
  sessions: 10,
  multiTurn: 4,
  wentOn: 0,
  columns: [
    {
      position: 1,
      sessions: 10,
      ended: 6,
      nodes: [
        {
          key: "t_pay",
          sessions: 7,
          unanswered: 1,
          ended: 4,
          next: [
            { key: "t_delivery", sessions: 2 },
            { key: "retry", sessions: 1 },
          ],
          tools: [],
          examples: [],
        },
        {
          key: "t_delivery",
          sessions: 3,
          unanswered: 3,
          ended: 2,
          next: [{ key: "other", sessions: 1 }],
          tools: [],
          examples: [],
        },
      ],
    },
    {
      position: 2,
      sessions: 4,
      ended: 4,
      nodes: [
        {
          key: "t_delivery",
          sessions: 2,
          unanswered: 0,
          ended: 2,
          next: [],
          tools: [],
          examples: [],
        },
        { key: "retry", sessions: 1, unanswered: 0, ended: 1, next: [], tools: [], examples: [] },
        { key: "other", sessions: 1, unanswered: 0, ended: 1, next: [], tools: [], examples: [] },
      ],
    },
  ],
};

test("a column is named by which ask it holds, never a step (a task's Steps are its tools)", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 11].map(askOrdinal), [
    "1st ask",
    "2nd ask",
    "3rd ask",
    "4th ask",
    "5th ask",
    "11th ask",
  ]);
});

test("one column per ask, chips by id, Ended in the next column, and a Then column after the last step", () => {
  const layout = layoutFlow(FLOW, TOPICS)!;
  assert.deepEqual(
    layout.columns.map((c) => [c.title, c.sessions]),
    [
      ["1st ask", 10],
      ["2nd ask", 4],
      ["Then", 4],
    ],
  );
  assert.deepEqual(
    layout.chips.map((c) => [c.id, c.kind, c.label, c.sessions]),
    [
      ["1:t_pay", "topic", "Payment status", 7],
      ["1:t_delivery", "topic", "Material delivery", 3],
      ["2:t_delivery", "topic", "Material delivery", 2],
      ["2:retry", "retry", "Asked again", 1],
      ["2:other", "other", "Other", 1],
      ["2:ended", "ended", "Ended", 6],
      ["3:ended", "ended", "Ended", 4],
    ],
  );
  const pay = layout.chips[0]!;
  assert.equal(pay.slot, "chart-1");
  assert.equal(pay.share, 0.7);
  assert.equal(layout.chips[1]!.mostlyUnanswered, false, "3 conversations are too few to say");
  assert.equal(layout.chips[5]!.share, 0.6, "of those at the step before");
  assert.equal(
    layout.width,
    2 * FLOW_GEOMETRY.columnWidth + FLOW_GEOMETRY.thenWidth + 2 * FLOW_GEOMETRY.gap,
    "the Then column is narrower",
  );
});

test("ribbons join each chip to where its conversations went, never crossing at an edge", () => {
  const layout = layoutFlow(FLOW, TOPICS)!;
  assert.deepEqual(
    layout.ribbons.map((r) => [r.id, r.sessions, r.terminal]),
    [
      ["1:t_pay>2:t_delivery", 2, false],
      ["1:t_pay>2:retry", 1, false],
      ["1:t_pay>2:ended", 4, true],
      ["1:t_delivery>2:other", 1, false],
      ["1:t_delivery>2:ended", 2, true],
      ["2:t_delivery>3:ended", 2, true],
      ["2:retry>3:ended", 1, true],
      ["2:other>3:ended", 1, true],
    ],
  );
  // Out of Payment status, stacked in the order of where they go: delivery, retry, ended.
  const tops = layout.ribbons.slice(0, 3).map((r) => Number(r.path.split(" ")[1]));
  assert.ok(
    tops[0]! < tops[1]! && tops[1]! < tops[2]!,
    `stacked top to bottom: ${tops.join(", ")}`,
  );
  for (const ribbon of layout.ribbons) assert.match(ribbon.path, /^M[\d.]+ [\d.]+ C.* Z$/);
});

test("past the fourth step, those who went on flow into Went on", () => {
  const nodes = (position: number) => ({
    position,
    sessions: 2,
    ended: position === 4 ? 1 : 0,
    nodes: [
      {
        key: "t_pay",
        sessions: 2,
        unanswered: 0,
        ended: position === 4 ? 1 : 0,
        next: position < 4 ? [{ key: "t_pay", sessions: 2 }] : [],
        tools: [],
        examples: [],
      },
    ],
  });
  const layout = layoutFlow(
    { sessions: 2, multiTurn: 2, wentOn: 1, columns: [1, 2, 3, 4].map(nodes) },
    TOPICS,
  )!;
  const then = layout.chips.filter((c) => c.position === 5);
  assert.deepEqual(
    then.map((c) => [c.kind, c.sessions]),
    [
      ["ended", 1],
      ["went_on", 1],
    ],
  );
  assert.ok(layout.ribbons.some((r) => r.id === "4:t_pay>5:went_on"));
});

test("an empty flow lays out nothing; a band path is a closed shape", () => {
  assert.equal(layoutFlow({ sessions: 0, multiTurn: 0, wentOn: 0, columns: [] }, TOPICS), null);
  assert.equal(
    bandPath(0, 10, 100, 20, 4),
    "M0 10 C50 10 50 20 100 20 L100 24 C50 24 50 14 0 14 Z",
  );
});

test("a chip lights its neighbours one ribbon away", () => {
  const layout = layoutFlow(FLOW, TOPICS)!;
  const lit = flowNeighbourhood(layout, "2:retry");
  assert.deepEqual([...lit.chips].sort(), ["1:t_pay", "2:retry", "3:ended"]);
  assert.deepEqual([...lit.ribbons].sort(), ["1:t_pay>2:retry", "2:retry>3:ended"]);
});

test("ribbons into a crowded Ended chip narrow to fit it; topic chips set the scale", () => {
  const nodes = Array.from({ length: 6 }, (_, i) => ({
    key: `t${i}`,
    sessions: 40,
    unanswered: 0,
    ended: 40,
    next: [],
    tools: [],
    examples: [],
  }));
  const layout = layoutFlow(
    {
      sessions: 240,
      multiTurn: 0,
      wentOn: 0,
      columns: [{ position: 1, sessions: 240, ended: 240, nodes }],
    },
    new Map(),
  )!;
  const ribbon = layout.ribbons[0]!;
  const numbers = ribbon.path.match(/-?[\d.]+/g)!.map(Number);
  const [, y0] = numbers;
  const leaving = numbers.at(-1)! - y0!;
  assert.ok(leaving > 30, `a topic chip's ribbon is thick where it leaves: ${leaving}`);
  const ended = layout.chips.find((chip) => chip.kind === "ended")!;
  const arrivals = layout.ribbons.map((r) => {
    const n = r.path.match(/-?[\d.]+/g)!.map(Number);
    return n[9]! - n[7]!;
  });
  const total = arrivals.reduce((sum, t) => sum + t, 0);
  assert.ok(
    total <= ended.h - 2 * FLOW_GEOMETRY.endedInset + 0.5,
    `together they fit the Ended chip: ${total}`,
  );
});

test("a task step is drawn as a task: its name, its color, and kind task", () => {
  const stats: FlowStats = {
    sessions: 2,
    multiTurn: 0,
    wentOn: 0,
    columns: [
      {
        position: 1,
        sessions: 2,
        ended: 2,
        nodes: [
          {
            key: "task:wf_track",
            sessions: 2,
            unanswered: 0,
            ended: 2,
            next: [],
            tools: [],
            examples: [],
          },
        ],
      },
    ],
  };
  const layout = layoutFlow(
    stats,
    new Map([["task:wf_track", { name: "Track material delivery", slot: "chart-5" as const }]]),
  )!;
  const chip = layout.chips.find((c) => c.key === "task:wf_track")!;
  assert.deepEqual(
    { kind: chip.kind, label: chip.label, slot: chip.slot },
    { kind: "task", label: "Track material delivery", slot: "chart-5" },
  );
});

test("a tool step is drawn as a tool: its id, neutral, and kind tool", () => {
  const stats: FlowStats = {
    sessions: 1,
    multiTurn: 0,
    wentOn: 0,
    columns: [
      {
        position: 1,
        sessions: 1,
        ended: 1,
        nodes: [
          {
            key: "tool:update_task",
            sessions: 1,
            unanswered: 0,
            ended: 1,
            next: [],
            tools: [],
            examples: [],
          },
        ],
      },
    ],
  };
  const chip = layoutFlow(stats, new Map())!.chips.find((c) => c.key === "tool:update_task")!;
  assert.deepEqual(
    { kind: chip.kind, label: chip.label, slot: chip.slot },
    { kind: "tool", label: "update_task", slot: null },
  );
});
