import assert from "node:assert/strict";
import { test } from "node:test";
import { createTraceSource } from "../adapters/trace-source";

test("an RQL dataset runs no query where RQL is off (the customMonitoring flag of run_rql)", async () => {
  const asked: string[] = [];
  const source = createTraceSource({} as never, {
    readOnlyTools: async () => new Set(),
    now: () => new Date(),
    rqlEnabled: async (projectId) => {
      asked.push(projectId);
      return false;
    },
  });
  const table = await source.runRql("p1", "select trace_id from traces");
  assert.deepEqual(table, {
    ok: false,
    message: "RQL is not on for this project, so an RQL dataset cannot resolve here.",
  });
  assert.deepEqual(asked, ["p1"]);
});
