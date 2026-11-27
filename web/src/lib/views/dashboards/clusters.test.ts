import assert from "node:assert/strict";
import { test } from "node:test";
import { selectClusters } from "@/lib/views/dashboards/clusters";
import { mapModelFrom } from "@/lib/views/intents/map/tool-network-fixture";

/** Deploys: deploy 20, logs 5. Billing: refund 8, the skill polite 2. Reports: logs 3. */
const MODEL = (() => {
  const model = mapModelFrom([
    ["deploys", "deploy", 20],
    ["deploys", "logs", 5],
    ["billing", "refund", 8],
    ["billing", "skill:polite", 2],
    ["reports", "logs", 3],
  ]);
  const task = new Map([
    ["tool:deploy", "t1"],
    ["tool:refund", "t2"],
  ]);
  return {
    ...model,
    capabilities: model.capabilities.map((item) => ({ ...item, task: task.get(item.id) ?? null })),
    tasks: [
      { id: "t1", name: "Ship a release", slot: null, runs: 3, steps: [] },
      { id: "t2", name: "Refund", slot: null, runs: 2, steps: [] },
    ],
  };
})();

function part(subset: Parameters<typeof selectClusters>[1]) {
  const { asks, capabilities, links } = selectClusters(MODEL, subset);
  return [
    asks.map(({ id }) => id),
    capabilities.map(({ id, calls }) => `${id} ${calls}`),
    links.length,
  ];
}

test("no subset is the whole map", () => {
  assert.deepEqual(selectClusters(MODEL, {}), MODEL);
});

test("clusters are picked by name and by size, with the tools they called", () => {
  // The fixture's label of "billing" is "ask billing"; the case does not count.
  assert.deepEqual(part({ clusters: ["Ask Billing"] }), [
    ["billing"],
    ["tool:refund 8", "skill:polite 2"],
    2,
  ]);
  assert.deepEqual(part({ minSize: 10 }), [
    ["deploys", "billing"],
    ["tool:deploy 20", "tool:refund 8", "tool:logs 5", "skill:polite 2"],
    4,
  ]);
});

test("tools, skills and tasks keep the clusters that used them, and count only those calls", () => {
  assert.deepEqual(part({ tools: ["logs"] }), [["deploys", "reports"], ["tool:logs 8"], 2]);
  // Values are alternatives, and so are tools and skills; properties combine.
  assert.deepEqual(part({ tools: ["deploy"], skills: ["polite"] }), [
    ["deploys", "billing"],
    ["tool:deploy 20", "skill:polite 2"],
    2,
  ]);
  assert.deepEqual(part({ tasks: ["ship a release"] }), [["deploys"], ["tool:deploy 20"], 1]);
  assert.deepEqual(part({ tools: ["logs"], minSize: 20 }), [["deploys"], ["tool:logs 5"], 1]);
});

test("a subset nothing matches is empty", () => {
  for (const subset of [
    { clusters: ["nope"] },
    { tools: ["polite"] },
    { tasks: ["nope"] },
    { minSize: 1000 },
    { tools: ["refund"], tasks: ["Ship a release"] },
  ])
    assert.deepEqual(part(subset), [[], [], 0], JSON.stringify(subset));
});
