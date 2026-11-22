import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPivotFilterOptions } from "@/lib/synthesis/pivots/filter-options";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

test("the bar filters by the configured pivots, keys and labels only", async () => {
  const options = await loadPivotFilterOptions(PROJECT_ID, async () => [
    { key: "client", label: "Client company", presetId: "client", position: 0 } as never,
  ]);
  assert.deepEqual(options, [{ key: "client", label: "Client company" }]);
});

test("a project with no pivot has no pivot filter", async () => {
  assert.deepEqual(await loadPivotFilterOptions(PROJECT_ID, async () => []), []);
});
