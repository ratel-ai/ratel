import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { ReplayDb } from "@/lib/views/session-replay/load";
import { loadStepContent } from "./inspect-load";

/** RC-284: the inspector reads stored text only with the content opt-in on, and only of the project. */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "11111111-1111-4111-8111-111111111112";
const CALL = "55555555-5555-4555-8555-555555555551";
const OTHER_CALL = "55555555-5555-4555-8555-555555555559";
const SEARCH = "44444444-4444-4444-8444-444444444441";

type Db = ReturnType<typeof getDb>;

async function setup() {
  const client = await createMigratedPGlite();
  const payload = JSON.stringify({
    provider: "anthropic",
    model: "m",
    ts: "x",
    system: "Be brief.",
    tools: [{ name: "get_seat_map", parameters: {} }],
    messages: [{ role: "user", content: "Aisle seat please" }],
    input_message_count: 1,
    settings: { temperature: 0.2 },
  });
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a'), ('${OTHER_PROJECT}', '${ORG}', 'B', 'b');
    insert into events (id, project_id, trace_id, occurred_at, model, payload) values
      ('${CALL}', '${PROJECT}', 'tr1', '2026-10-20T10:00:01Z', 'm', '${payload}'),
      ('${OTHER_CALL}', '${OTHER_PROJECT}', 'tr1', '2026-10-20T10:00:01Z', 'm', '${payload}');
    insert into trace_events (id, project_id, type, client_event_id, trace_id, occurred_at, query, payload) values
      ('${SEARCH}', '${PROJECT}', 'search', 'c1', 'tr1', '2026-10-20T10:00:02Z', 'seat map', '{}');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

test("opt-in off: no payload is read at all", async () => {
  const db = { select: () => assert.fail("read with the opt-in off") } as unknown as ReplayDb;
  assert.equal(
    await loadStepContent(
      PROJECT,
      { eventIds: [CALL], searchEventId: SEARCH },
      { readContent: false },
      db,
    ),
    null,
  );
});

test("opt-in on: the stored payload as it is, its sections and the search query", async () => {
  const { client, db } = await setup();
  try {
    const content = await loadStepContent(
      PROJECT,
      { eventIds: [CALL], searchEventId: SEARCH },
      { readContent: true },
      db,
    );
    assert.ok(content);
    const call = content.calls[CALL];
    assert.ok(call);
    assert.equal((call.raw as { system: string }).system, "Be brief.");
    assert.deepEqual(
      call.view.tools.map((t) => t.name),
      ["get_seat_map"],
    );
    assert.deepEqual(call.view.settings, { temperature: 0.2 });
    assert.equal(content.query, "seat map");
  } finally {
    await client.close();
  }
});

test("another project's call is never read; ids that are not uuids are dropped", async () => {
  const { client, db } = await setup();
  try {
    const content = await loadStepContent(
      PROJECT,
      { eventIds: [OTHER_CALL, "x' or 1=1"], searchEventId: "nope" },
      { readContent: true },
      db,
    );
    assert.deepEqual(content, { calls: {}, query: null });
  } finally {
    await client.close();
  }
});
