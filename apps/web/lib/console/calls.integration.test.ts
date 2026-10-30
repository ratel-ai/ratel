import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { listModelCalls, parseCallsCursor } from "./calls";

const ORG = "22222222-2222-4222-8222-222222222222";
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "33333333-3333-4333-8333-333333333333";

type Db = NonNullable<Parameters<typeof listModelCalls>[2]>;

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug) values
       ('${P1}', '${ORG}', 'One', 'one'), ('${P2}', '${ORG}', 'Two', 'two');
     insert into events (id, project_id, occurred_at, received_at, provider, model, input_tokens, output_tokens, cost_usd, latency_ms) values
       ('00000000-0000-4000-8000-000000000001', '${P1}', '2026-10-01T10:00:00Z', now(), 'openai', 'gpt-a', 10, 1, 0.5, 100),
       ('00000000-0000-4000-8000-000000000002', '${P1}', '2026-10-01T11:00:00Z', now(), 'openai', 'gpt-b', 20, 2, null, null),
       ('00000000-0000-4000-8000-000000000003', '${P1}', '2026-10-01T11:00:00Z', now(), 'openai', 'gpt-c', 30, 3, 0.1, 50),
       ('00000000-0000-4000-8000-000000000004', '${P1}', null, '2026-10-01T09:00:00Z', 'anthropic', 'claude-x', 40, 4, 0.2, 70),
       ('00000000-0000-4000-8000-000000000005', '${P2}', '2026-10-01T12:00:00Z', now(), 'openai', 'other', 1, 1, 0, 1);`,
  );
  return drizzle(client) as unknown as Db;
}

test("calls are the project's own, newest first, falling back to the receive time", async () => {
  const db = await setup();
  const page = await listModelCalls(P1, { limit: 10 }, db);
  assert.deepEqual(
    page.rows.map((row) => row.model),
    ["gpt-c", "gpt-b", "gpt-a", "claude-x"],
  );
  assert.equal(page.next, null);
  assert.equal(page.rows[0].costUsd, 0.1);
  assert.equal(page.rows[1].costUsd, null);
});

test("the cursor continues after the last row, ties broken by id", async () => {
  const db = await setup();
  const first = await listModelCalls(P1, { limit: 2 }, db);
  assert.deepEqual(
    first.rows.map((row) => row.model),
    ["gpt-c", "gpt-b"],
  );
  assert.ok(first.next);
  const second = await listModelCalls(P1, { limit: 2, after: parseCallsCursor(first.next) }, db);
  assert.deepEqual(
    second.rows.map((row) => row.model),
    ["gpt-a", "claude-x"],
  );
  assert.equal(second.next, null);
});

test("a malformed cursor is ignored", () => {
  assert.equal(parseCallsCursor(undefined), null);
  assert.equal(parseCallsCursor("nope"), null);
  assert.equal(parseCallsCursor("2026-13-45T00:00:00Z_00000000-0000-4000-8000-000000000001"), null);
  assert.equal(parseCallsCursor("2026-10-01T11:00:00.000Z_not-a-uuid"), null);
  assert.deepEqual(
    parseCallsCursor("2026-10-01T11:00:00.000Z_00000000-0000-4000-8000-000000000003"),
    {
      at: new Date("2026-10-01T11:00:00.000Z"),
      id: "00000000-0000-4000-8000-000000000003",
    },
  );
});
