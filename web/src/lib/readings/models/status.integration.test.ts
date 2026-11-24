import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { dbModelFailureStore } from "./status";

async function store() {
  const db = drizzle(await createMigratedPGlite()) as unknown as ReturnType<typeof getDb>;
  return dbModelFailureStore(db);
}

const FAILED = {
  feature: "workflow_label",
  kind: "text" as const,
  provider: "openai",
  model: "gpt-6.2-sol",
  message: "OpenAI refused the key in OPENAI_API_KEY (401).",
  status: 401,
};

test("a failure is kept per feature, counted, and the next one replaces its words", async () => {
  const failures = await store();
  await failures.failed({ ...FAILED, at: new Date("2026-11-24T10:00:00Z") });
  await failures.failed({
    ...FAILED,
    message: "OpenAI is rate limiting gpt-6.2-sol (429).",
    status: 429,
    at: new Date("2026-11-24T10:05:00Z"),
  });
  const [row] = await failures.list();
  assert.equal(row.feature, "workflow_label");
  assert.equal(row.failures, 2);
  assert.equal(row.status, 429);
  assert.match(row.message, /429/);
  assert.equal(row.failedAt.toISOString(), "2026-11-24T10:05:00.000Z");
  assert.equal(row.okAt, null);
});

test("a write can carry the failures held back since the last one", async () => {
  const failures = await store();
  await failures.failed({ ...FAILED, at: new Date("2026-11-24T10:00:00Z") });
  await failures.failed({ ...FAILED, count: 5, at: new Date("2026-11-24T10:01:00Z") });
  assert.equal((await failures.list())[0].failures, 6);
  await failures.succeeded("workflow_label", new Date("2026-11-24T10:02:00Z"));
  await failures.failed({ ...FAILED, count: 3, at: new Date("2026-11-24T10:03:00Z") });
  assert.equal((await failures.list())[0].failures, 3);
});

test("a call that works afterwards marks the feature as working again, and resets the count", async () => {
  const failures = await store();
  await failures.failed({ ...FAILED, at: new Date("2026-11-24T10:00:00Z") });
  await failures.succeeded("workflow_label", new Date("2026-11-24T10:10:00Z"));
  await failures.succeeded("topics_names", new Date("2026-11-24T10:10:00Z"));
  const rows = await failures.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].okAt?.toISOString(), "2026-11-24T10:10:00.000Z");
  await failures.failed({ ...FAILED, at: new Date("2026-11-24T10:20:00Z") });
  assert.equal((await failures.list())[0].failures, 1);
});
