import assert from "node:assert/strict";
import { test } from "node:test";
import { topicMapModel } from "@/lib/views/intents/topics-map-model";
import type { TopicView } from "@/lib/views/intents/topics-view";

function topic(over: Partial<TopicView> & { id: string; name: string }): TopicView {
  return {
    description: "",
    turns: 10,
    share: 0.1,
    asks: 4,
    trend: [],
    answered: 10,
    answeredShare: 1,
    mostlyUnanswered: false,
    sentiment: null,
    tasks: [],
    untasked: 0,
    tools: [],
    selfCorrections: null,
    askedAgain: 0,
    next: [],
    flowStart: false,
    slot: null,
    links: { selfCorrections: "", fixes: "", flows: "" },
    ...over,
  };
}

test("topics become the map's groups, the tools their turns called its capabilities, colored by main task", () => {
  const model = topicMapModel(
    {
      topics: [
        topic({
          id: "t_pay",
          name: "Payment status",
          turns: 40,
          slot: "chart-1",
          tools: [
            { id: "get_payment", calls: 30, failures: 2, failureShare: 2 / 30 },
            { id: "skill:billing", calls: 10, failures: 0, failureShare: 0 },
          ],
        }),
        topic({
          id: "t_delivery",
          name: "Material delivery",
          turns: 12,
          answered: 3,
          answeredShare: 0.25,
          mostlyUnanswered: true,
          tools: [{ id: "get_payment", calls: 4, failures: 4, failureShare: 1 }],
        }),
      ],
      taskSlots: { wf_pay: "chart-1" },
    },
    [
      { id: "get_payment", calls: 34, failures: 6, task: "wf_pay" },
      { id: "skill:billing", calls: 10, failures: 0, task: null },
    ],
  );
  assert.deepEqual(
    model.asks.map((a) => [a.id, a.label, a.volume, a.tint, a.problem]),
    [
      ["t_pay", "Payment status", 40, "chart-1", null],
      ["t_delivery", "Material delivery", 12, null, { kind: "unanswered", rate: 0.75 }],
    ],
  );
  assert.deepEqual(
    model.capabilities.map((c) => [c.id, c.kind, c.name, c.calls, c.asks, c.tint]),
    [
      ["tool:get_payment", "tool", "get_payment", 34, 2, "chart-1"],
      ["skill:billing", "skill", "billing", 10, 1, null],
    ],
  );
  assert.deepEqual(model.links, [
    { ask: "t_pay", capability: "tool:get_payment", weight: 30, share: 0.75 },
    { ask: "t_pay", capability: "skill:billing", weight: 10, share: 0.25 },
    { ask: "t_delivery", capability: "tool:get_payment", weight: 4, share: 1 },
  ]);
  assert.equal(model.hidden, null);
});

test("the model carries the tasks its tools belong to, named and colored as everywhere, with their steps", () => {
  const model = topicMapModel(
    {
      topics: [
        topic({
          id: "t_pay",
          name: "Payment status",
          tools: [
            { id: "get_payment", calls: 30, failures: 2, failureShare: 2 / 30 },
            { id: "notify_team", calls: 5, failures: 0, failureShare: 0 },
          ],
        }),
      ],
      taskSlots: { wf_pay: "chart-1" },
      taskNames: { wf_pay: "Check a payment", wf_notify: "Notify the team" },
    },
    [
      { id: "get_payment", calls: 30, failures: 2, task: "wf_pay" },
      { id: "notify_team", calls: 5, failures: 0, task: null },
    ],
    [
      { id: "wf_pay", runs: 90, steps: ["get_invoice", "get_payment"] },
      { id: "wf_notify", runs: 12, steps: ["notify_team"] },
      { id: "wf_elsewhere", runs: 400, steps: ["deploy"] },
    ],
  );
  assert.deepEqual(
    model.capabilities.map((c) => [c.id, c.task]),
    [
      ["tool:get_payment", "wf_pay"],
      ["tool:notify_team", null],
    ],
  );
  assert.deepEqual(
    model.tasks,
    [
      {
        id: "wf_pay",
        name: "Check a payment",
        slot: "chart-1",
        runs: 90,
        steps: ["tool:get_invoice", "tool:get_payment"],
      },
      {
        id: "wf_notify",
        name: "Notify the team",
        slot: null,
        runs: 12,
        steps: ["tool:notify_team"],
      },
    ],
    "a task none of the drawn tools is in stays out",
  );
});

test("without the task reading, a tool's main task is still a task of the model", () => {
  const model = topicMapModel(
    {
      topics: [
        topic({
          id: "t_pay",
          name: "Payment status",
          tools: [{ id: "get_payment", calls: 3, failures: 0, failureShare: 0 }],
        }),
      ],
      taskSlots: {},
    },
    [{ id: "get_payment", calls: 3, failures: 0, task: "wf_pay" }],
  );
  assert.deepEqual(model.tasks, [
    { id: "wf_pay", name: "Unnamed task", slot: null, runs: 0, steps: [] },
  ]);
});
