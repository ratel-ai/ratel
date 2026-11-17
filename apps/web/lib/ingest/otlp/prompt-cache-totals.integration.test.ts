import assert from "node:assert/strict";
import { test } from "node:test";
import { getPromptCacheTotals } from "@/lib/ingest/otlp/queries";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";

/** RC-382: the window's cached and input tokens, read from `events` on the event time. */

test("sums cached and input tokens of the window by event time", async () => {
  const { client, db } = await setupDb();
  await client.exec(`
    insert into events (project_id, occurred_at, received_at, input_tokens, cached_tokens) values
      ('${PROJECT_ID}', '2026-10-14T10:00:00Z', '2026-10-14T10:00:01Z', 1050, 900),
      ('${PROJECT_ID}', null,                   '2026-10-15T09:00:00Z', 500,  null),
      ('${PROJECT_ID}', '2026-10-01T10:00:00Z', '2026-10-14T10:00:00Z', 9999, 9999),
      ('${PROJECT_ID}', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z', 7777, 7777);
  `);
  const totals = await getPromptCacheTotals(
    PROJECT_ID,
    new Date("2026-10-13T00:00:00Z"),
    new Date("2026-10-16T00:00:00Z"),
    db as unknown as BoundReadDb,
  );
  assert.deepEqual(totals, { cachedTokens: 900, inputTokens: 1_550 });
});

test("an empty window is zero, not null", async () => {
  const { db } = await setupDb();
  const totals = await getPromptCacheTotals(
    PROJECT_ID,
    new Date("2026-10-13T00:00:00Z"),
    undefined,
    db as unknown as BoundReadDb,
  );
  assert.deepEqual(totals, { cachedTokens: 0, inputTokens: 0 });
});
