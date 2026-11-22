import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPivotFilterOptions } from "@/lib/synthesis/pivots/filter-options";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

test("with cloud-pivots off no pivot is read and the bar has no pivot filter", async () => {
  let listed = false;
  const options = await loadPivotFilterOptions(PROJECT_ID, null, {
    enabled: async () => false,
    list: async () => {
      listed = true;
      return [{ key: "client", label: "Client company" }];
    },
  });
  assert.deepEqual(options, []);
  assert.equal(listed, false);
});

test("with cloud-pivots on the bar filters by the configured pivots, keys and labels only", async () => {
  const options = await loadPivotFilterOptions(PROJECT_ID, null, {
    enabled: async () => true,
    list: async () => [
      { key: "client", label: "Client company", presetId: "client", position: 0 } as never,
    ],
  });
  assert.deepEqual(options, [{ key: "client", label: "Client company" }]);
});
