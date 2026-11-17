import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { CURRENT_PRICES, costFor } from "@/lib/ingest/pricing";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadJobPriceBook, loadPriceBook } from "./price-book";
import { saveModelPrice } from "./store";

/** RC-482: a project's costs use the current prices and its own. */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";

async function seeded() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof getDb> };
}

test("a project's price book is the current prices and its own", async () => {
  const { client, db } = await seeded();
  try {
    await saveModelPrice(PROJECT, "my-own-model", { input: 1, output: 2 }, "user_1", db);
    const usage = { input_tokens: 100_000, output_tokens: 0 };

    const book = await loadPriceBook(PROJECT, db);
    // Current gpt-5.5: $5 in.
    assert.equal(costFor("gpt-5.5", usage, book), 0.5);
    assert.equal(costFor("my-own-model", usage, book), 0.1);
  } finally {
    await client.close();
  }
});

test("a job's price book falls back to the current built-in prices when the read fails, and logs it", async () => {
  const { client, db } = await seeded();
  try {
    const errors: string[] = [];
    const log = (message: string) => errors.push(message);
    await saveModelPrice(PROJECT, "my-own-model", { input: 1, output: 2 }, "user_1", db);
    assert.deepEqual(await loadJobPriceBook(PROJECT, db, { logError: log }), {
      overrides: { "my-own-model": { input: 1, output: 2 } },
    });
    assert.deepEqual(errors, []);

    await client.exec(`alter table project_model_prices rename to project_model_prices_gone`);
    assert.equal(await loadJobPriceBook(PROJECT, db, { logError: log }), CURRENT_PRICES);
    assert.deepEqual(errors, ["model price book unreadable"]);
  } finally {
    await client.close();
  }
});
