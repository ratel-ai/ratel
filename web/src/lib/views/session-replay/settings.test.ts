import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import {
  CONTENT_OPT_IN_ERRORS,
  type ContentOptInDeps,
  loadStepTexts,
  payloadText,
  setContentOptIn,
} from "./settings";

/** RC-177: only an admin turns content reading on; text is read only for the asked calls of the project. */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "11111111-1111-4111-8111-111111111112";
const EVENT = "44444444-4444-4444-8444-444444444441";
const OTHER_EVENT = "44444444-4444-4444-8444-444444444442";

type Db = ReturnType<typeof getDb>;

async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a'), ('${OTHER_PROJECT}', '${ORG}', 'B', 'b');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

function deps(
  db: Db,
  role: string | null,
  options: { restricted?: boolean } = {},
): ContentOptInDeps & { tracked: unknown[] } {
  const tracked: unknown[] = [];
  return {
    db,
    getActor: async () => ({ userId: "u1", externalId: "user_1" }),
    findRole: async () => role,
    isRestricted: async () => options.restricted ?? false,
    track: async (event) => {
      tracked.push(event);
    },
    tracked,
  };
}

test("RC-471: a new project reads content as on", async () => {
  const { client, db } = await setup();
  try {
    assert.equal(await contentOptIn(PROJECT, db), true);
  } finally {
    await client.close();
  }
});

test("RC-471: an admin's choice wins over the default", async () => {
  const { client, db } = await setup();
  try {
    await client.exec(
      `insert into session_replay_settings (project_id, read_content) values ('${PROJECT}', false), ('${OTHER_PROJECT}', true)`,
    );
    assert.equal(await contentOptIn(PROJECT, db), false);
    assert.equal(await contentOptIn(OTHER_PROJECT, db), true);
  } finally {
    await client.close();
  }
});

test("an admin turns content reading off and on, and each change is tracked", async () => {
  const { client, db } = await setup();
  try {
    const admin = deps(db, "admin");
    assert.equal(await contentOptIn(PROJECT, db), true);
    assert.deepEqual(await setContentOptIn(PROJECT, false, admin), {
      ok: true,
      readContent: false,
    });
    assert.equal(await contentOptIn(PROJECT, db), false);
    assert.deepEqual(await setContentOptIn(PROJECT, true, admin), { ok: true, readContent: true });
    assert.equal(await contentOptIn(PROJECT, db), true);
    assert.deepEqual(admin.tracked, [
      { externalId: "user_1", projectId: PROJECT, readContent: false },
      { externalId: "user_1", projectId: PROJECT, readContent: true },
    ]);
  } finally {
    await client.close();
  }
});

test("a member who is not an admin cannot change it", async () => {
  const { client, db } = await setup();
  try {
    const member = deps(db, "member");
    assert.deepEqual(await setContentOptIn(PROJECT, false, member), {
      ok: false,
      error: CONTENT_OPT_IN_ERRORS.not_admin,
    });
    assert.equal(await contentOptIn(PROJECT, db), true);
    assert.equal(member.tracked.length, 0);
  } finally {
    await client.close();
  }
});

test("a non-member, a signed-out caller and a support session are refused", async () => {
  const { client, db } = await setup();
  try {
    assert.deepEqual(await setContentOptIn(PROJECT, false, deps(db, null)), {
      ok: false,
      error: CONTENT_OPT_IN_ERRORS.not_found,
    });
    assert.deepEqual(
      await setContentOptIn(PROJECT, false, { ...deps(db, "admin"), getActor: async () => null }),
      { ok: false, error: CONTENT_OPT_IN_ERRORS.signed_out },
    );
    assert.deepEqual(
      await setContentOptIn(PROJECT, false, deps(db, "admin", { restricted: true })),
      { ok: false, error: CONTENT_OPT_IN_ERRORS.restricted },
    );
    assert.equal(await contentOptIn(PROJECT, db), true);
  } finally {
    await client.close();
  }
});

test("payloadText keeps the system prompt and the last messages with text, each cut short", () => {
  const messages = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `m${i}`,
  }));
  const text = payloadText({
    system: "s".repeat(700),
    messages: [
      ...messages,
      { role: "assistant", content: [{ type: "tool_call", id: "t" }] },
      { role: "tool", tool_call_id: "t", content: [{ type: "text", text: "done" }] },
    ],
  });
  assert.ok(text);
  assert.equal(text.system, `${"s".repeat(600)}…`);
  assert.deepEqual(
    text.messages.map((m) => m.text),
    ["m3", "m4", "m5", "m6", "m7", "done"],
  );
  assert.equal(text.omitted, 3);
  assert.equal(payloadText({ messages: [{ role: "user", content: "" }] }), null);
  assert.equal(payloadText(null), null);
});

test("loadStepTexts reads only the asked calls of the project", async () => {
  const { client, db } = await setup();
  try {
    const payload = JSON.stringify({
      messages: [{ role: "user", content: "Book a flight to Rome" }],
    });
    await client.query(
      `insert into events (id, project_id, received_at, payload) values ($1, $2, now(), $3::jsonb), ($4, $5, now(), $3::jsonb)`,
      [EVENT, PROJECT, payload, OTHER_EVENT, OTHER_PROJECT],
    );
    const texts = await loadStepTexts(PROJECT, [EVENT, OTHER_EVENT], db);
    assert.deepEqual([...texts.keys()], [EVENT]);
    assert.deepEqual(texts.get(EVENT)?.messages, [{ role: "user", text: "Book a flight to Rome" }]);
  } finally {
    await client.close();
  }
});
