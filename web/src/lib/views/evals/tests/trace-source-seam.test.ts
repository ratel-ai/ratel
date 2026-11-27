import assert from "node:assert/strict";
import { test } from "node:test";

test("the trace source of query datasets loads the RQL runner, so an RQL dataset resolves", async () => {
  const { metricSeams } = await import("@/lib/synthesis/metrics/query");
  assert.equal(metricSeams.sql, undefined, "nothing else loaded it in this test");
  await import("../adapters/trace-source");
  assert.equal(typeof metricSeams.sql, "function");
});
