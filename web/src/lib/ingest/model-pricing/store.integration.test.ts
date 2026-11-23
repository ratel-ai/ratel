import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { deleteModelPrice, listSeenModels, loadPriceOverrides, saveModelPrice } from "./store";

/** RC-482: a project's own model prices, and the models its traces used. */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "11111111-1111-4111-8111-111111111112";

type Db = ReturnType<typeof getDb>;

async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a'), ('${OTHER}', '${ORG}', 'B', 'b');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

test("a saved price is the project's override, and a reset removes it", async () => {
  const { client, db } = await setup();
  try {
    assert.deepEqual(await loadPriceOverrides(PROJECT, db), {});
    await saveModelPrice(PROJECT, "gpt-4o", { input: 2, output: 8, cachedInput: 1 }, "user_1", db);
    await saveModelPrice(OTHER, "gpt-4o", { input: 9, output: 9 }, "user_1", db);
    assert.deepEqual(await loadPriceOverrides(PROJECT, db), {
      "gpt-4o": { input: 2, output: 8, cachedInput: 1 },
    });

    // Saving again changes the same row.
    await saveModelPrice(PROJECT, "gpt-4o", { input: 3, output: 9, cacheWrite: 4 }, "user_1", db);
    assert.deepEqual(await loadPriceOverrides(PROJECT, db), {
      "gpt-4o": { input: 3, output: 9, cacheWrite: 4 },
    });

    assert.equal(await deleteModelPrice(PROJECT, "gpt-4o", db), true);
    assert.equal(await deleteModelPrice(PROJECT, "gpt-4o", db), false);
    assert.deepEqual(await loadPriceOverrides(PROJECT, db), {});
    assert.deepEqual(await loadPriceOverrides(OTHER, db), { "gpt-4o": { input: 9, output: 9 } });
  } finally {
    await client.close();
  }
});

test("seen models are the project's recent model calls, with how many have no cost", async () => {
  const { client, db } = await setup();
  try {
    const now = new Date();
    const old = new Date(now.getTime() - 60 * 86_400_000);
    await client.query(
      `insert into otel_spans (id, project_id, trace_id, span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, model, input_tokens, output_tokens, cost_usd, attributes)
       values
        ('a0000000-0000-4000-8000-000000000001', $1, 't1', 's1', 'chat', 1, 'llm_call', $3, $3, 1, 0, 'gpt-4o', 10, 5, null, '{}'),
        ('a0000000-0000-4000-8000-000000000002', $1, 't1', 's2', 'chat', 1, 'llm_call', $3, $3, 1, 0, 'gpt-4o', 10, 5, null, '{}'),
        ('a0000000-0000-4000-8000-000000000003', $1, 't1', 's3', 'chat', 1, 'llm_call', $3, $3, 1, 0, 'claude-sonnet-5-5', 10, 5, 0.1, '{}'),
        ('a0000000-0000-4000-8000-000000000004', $1, 't1', 's4', 'tool', 1, 'tool', $3, $3, 1, 0, null, null, null, null, '{}'),
        ('a0000000-0000-4000-8000-000000000005', $1, 't1', 's5', 'chat', 1, 'llm_call', $4, $4, 1, 0, 'old-model', 10, 5, null, '{}'),
        ('a0000000-0000-4000-8000-000000000006', $2, 't2', 's6', 'chat', 1, 'llm_call', $3, $3, 1, 0, 'other-project-model', 10, 5, null, '{}')`,
      [PROJECT, OTHER, now.toISOString(), old.toISOString()],
    );
    await client.query(
      `insert into events (project_id, occurred_at, model, input_tokens, output_tokens, cost_usd)
       values ($1, $2, 'mistral-small-2603', 10, 5, null)`,
      [PROJECT, now.toISOString()],
    );

    const seen = await listSeenModels(PROJECT, db, { now });
    assert.deepEqual(seen, [
      { model: "gpt-4o", calls: 2, unpricedCalls: 2 },
      { model: "claude-sonnet-5-5", calls: 1, unpricedCalls: 0 },
      { model: "mistral-small-2603", calls: 1, unpricedCalls: 1 },
    ]);
  } finally {
    await client.close();
  }
});
