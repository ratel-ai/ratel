import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadTopQueries } from "@/lib/platform/db/top-queries";

test("the migrations run where pg_stat_statements is missing, and the report says it is unavailable", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema });
  assert.equal(await loadTopQueries(db as never), null);
});
