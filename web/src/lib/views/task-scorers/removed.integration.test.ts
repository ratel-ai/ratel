import assert from "node:assert/strict";
import { test } from "node:test";
import { jobHandlers } from "@/lib/composition/registry";
import { assembleOperations } from "@/lib/mcp/operations";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

test("F448-1: no job scores tasks the old way, and its tables and waiting jobs are gone", async () => {
  const kinds = Object.keys(jobHandlers());
  assert.ok(kinds.includes("refresh_task_eval_set"));
  assert.ok(!kinds.includes("score_tasks"));
  const client = await createMigratedPGlite();
  try {
    const { rows } = await client.query(
      "select 1 from pg_tables where tablename in ('task_scorers', 'task_scores_daily')",
    );
    assert.equal(rows.length, 0);
  } finally {
    await client.close();
  }
});

test("F448-2: no MCP operation changes a task scorer that nothing reads", () => {
  const ids = assembleOperations().map(({ id }) => id);
  assert.ok(ids.includes("change_scorer") && ids.includes("get_task"));
  assert.ok(!ids.includes("change_task_scorer"));
});
