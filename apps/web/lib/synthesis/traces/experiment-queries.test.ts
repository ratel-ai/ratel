import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { type ExperimentQueriesDb, listExperimentDetectionAggregates } from "./experiment-queries";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WINDOW = {
  since: new Date("2026-07-30T00:00:00.000Z"),
  until: new Date("2026-07-31T00:00:00.000Z"),
};

test("experiment detection query materializes trace-root stages", async () => {
  const queries: string[] = [];
  const client = {
    async query(query: string) {
      queries.push(query);
      return { rows: [] };
    },
  } as unknown as PGlite;
  const db = drizzle({ client, schema }) as unknown as ExperimentQueriesDb;

  await listExperimentDetectionAggregates(PROJECT_ID, WINDOW, db);

  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /with "experiment_detection_window_traces" as materialized \(/i);
  assert.match(queries[0]!, /"experiment_detection_reps" as materialized \(/i);
});
