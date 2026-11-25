import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_DIR } from "@/lib/platform/db/test-support";

const INDEX = "otel_trace_summaries_project_updated_idx";

test("F445-4: the scorer migration runs with its index on the summaries already built", async () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const own = files.find((file) => file.endsWith("_trace_scorers.sql"));
  assert.ok(own);
  const read = (file: string) => readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  const first = read(own).match(
    new RegExp(`^--\\s+(CREATE INDEX CONCURRENTLY .*${INDEX}.*;)$`, "m"),
  );
  assert.ok(first, "the header says what to run before the deploy");
  const client = new PGlite();
  try {
    for (const file of files.slice(0, files.indexOf(own))) await client.exec(read(file));
    await client.exec(first[1]);
    await client.exec(read(own));
    const { rows } = await client.query("select 1 from pg_indexes where indexname = $1", [INDEX]);
    assert.equal(rows.length, 1);
  } finally {
    await client.close();
  }
});
