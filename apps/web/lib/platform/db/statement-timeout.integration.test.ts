import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  type BoundReadDb,
  readTimeoutMs,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

async function setup() {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as BoundReadDb;
  return { db };
}

async function currentTimeout(db: BoundReadDb): Promise<string> {
  const result = await db.execute(sql`select current_setting('statement_timeout') as t`);
  return String((result.rows[0] as { t: string }).t);
}

test("withStatementTimeout applies a transaction-scoped statement_timeout to the read", async () => {
  const { db } = await setup();

  const insideTxn = await withStatementTimeout((tx) => currentTimeout(tx), db, 20000);

  // Postgres normalises the millisecond value to its display form.
  assert.equal(insideTxn, "20s");
  // SET LOCAL is transaction-scoped, so the session default is restored after.
  assert.equal(await currentTimeout(db), "0");
});

test("withStatementTimeout leaves the session default untouched when disabled", async () => {
  const { db } = await setup();

  const insideRun = await withStatementTimeout((runDb) => currentTimeout(runDb), db, null);

  assert.equal(insideRun, "0");
});

test("withStatementTimeout returns the read result", async () => {
  const { db } = await setup();

  const value = await withStatementTimeout(async () => 42, db, 5000);

  assert.equal(value, 42);
});

test("withStatementTimeout applies primary and supplementary read tiers", async () => {
  const { db } = await setup();

  const primaryTimeout = await withStatementTimeout(
    (tx) => currentTimeout(tx),
    db,
    readTimeoutMs({}),
  );
  const supplementaryTimeout = await withStatementTimeout(
    (tx) => currentTimeout(tx),
    db,
    supplementaryReadTimeoutMs({}),
  );

  assert.equal(primaryTimeout, "15s");
  assert.equal(supplementaryTimeout, "5s");
});
