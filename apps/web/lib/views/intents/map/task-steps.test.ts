import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskSteps } from "@/lib/views/intents/map/queries";

test("a task reading's steps are read defensively: ids and run counts or nothing, steps once each, in order", () => {
  assert.deepEqual(parseTaskSteps(null), []);
  assert.deepEqual(parseTaskSteps({ items: [] }), []);
  assert.deepEqual(
    parseTaskSteps([
      {
        id: "wf_a",
        runs: 218,
        typicalOrder: ["list_projects", "get_purchase_order", "track_material_delivery"],
      },
      { id: "wf_b", runs: 12, typicalOrder: ["notify_team", 7, "", "notify_team", "skill:review"] },
      { id: "wf_c", runs: 5 },
      { id: 4, runs: 5, typicalOrder: ["x"] },
      { id: "wf_d", runs: "many", typicalOrder: ["x"] },
      "nonsense",
    ]),
    [
      {
        id: "wf_a",
        runs: 218,
        steps: ["list_projects", "get_purchase_order", "track_material_delivery"],
      },
      { id: "wf_b", runs: 12, steps: ["notify_team", "skill:review"] },
      { id: "wf_c", runs: 5, steps: [] },
    ],
  );
});
