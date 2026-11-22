import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultScorers } from "@/lib/views/task-scorers/defaults";

test("task defaults give cost and latency a quarter of room", () => {
  assert.deepEqual(defaultScorers({ selfCorrections: 2, costUsd: 0.003, latencyMs: 1001 }), [
    { kind: "ends_well" },
    { kind: "max_self_corrections", max: 2 },
    { kind: "max_cost_usd", max: 0.0038 },
    { kind: "max_latency_ms", max: 1252 },
  ]);
  assert.deepEqual(defaultScorers({ selfCorrections: 0, costUsd: 0, latencyMs: null }), [
    { kind: "ends_well" },
    { kind: "max_self_corrections", max: 0 },
  ]);
  assert.deepEqual(
    defaultScorers({ selfCorrections: null, costUsd: null, latencyMs: Number.NaN }),
    [{ kind: "ends_well" }],
  );
});
