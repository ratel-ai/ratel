import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { insertPivot, listPivots } from "@/lib/ingest/pivots/store";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  addPivot,
  PIVOT_SETTINGS_ERRORS,
  type PivotEvent,
  type PivotSettingsDeps,
  readPivots,
  removePivot,
  renamePivot,
  reorderPivot,
} from "@/lib/synthesis/pivots/settings";

/** RC-881: a member manages the project's pivots; each write is scoped and tracked. */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "11111111-1111-4111-8111-111111111112";

type Db = ReturnType<typeof getDb>;

async function setup(): Promise<Db> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a'), ('${OTHER}', '${ORG}', 'B', 'b');
  `);
  return drizzle(client, { schema }) as unknown as Db;
}

function deps(db: Db, options: { member?: boolean; restricted?: boolean } = {}) {
  const tracked: { event: PivotEvent; context: unknown; properties: Record<string, unknown> }[] =
    [];
  const value: PivotSettingsDeps = {
    db,
    getActor: async () => ({ userId: "u1", externalId: "user_1" }),
    findScope: async (projectId) =>
      (options.member ?? true) && projectId === PROJECT ? { organizationId: ORG } : null,
    isRestricted: async () => options.restricted ?? false,
    track: async (event, context, properties) => {
      tracked.push({ event, context, properties: { ...properties } });
    },
  };
  return { value, tracked };
}

test("add a preset and a custom key: listed in order and tracked as pivot_created", async () => {
  const db = await setup();
  const { value, tracked } = deps(db);

  assert.deepEqual(await addPivot(PROJECT, { presetId: "client" }, value), {
    ok: true,
    pivots: [{ key: "client", label: "Client company", presetId: "client", position: 0 }],
  });
  const result = await addPivot(PROJECT, { key: " customer.tier ", label: "Tier" }, value);
  assert.ok(result.ok);
  assert.deepEqual(
    result.pivots.map((pivot) => [pivot.key, pivot.label, pivot.position]),
    [
      ["client", "Client company", 0],
      ["customer.tier", "Tier", 1],
    ],
  );
  assert.deepEqual(tracked, [
    {
      event: "pivot_created",
      context: { externalId: "user_1", projectId: PROJECT, orgId: ORG },
      properties: { pivot_key: "client", preset_id: "client", pivot_count: 1 },
    },
    {
      event: "pivot_created",
      context: { externalId: "user_1", projectId: PROJECT, orgId: ORG },
      properties: { pivot_key: "customer.tier", preset_id: null, pivot_count: 2 },
    },
  ]);
  assert.deepEqual(await readPivots(PROJECT, value), { ok: true, pivots: result.pivots });
});

test("rename and move: pivot_updated with the change; positions stay 0..n-1", async () => {
  const db = await setup();
  const { value, tracked } = deps(db);
  for (const key of ["a", "b", "c"]) await addPivot(PROJECT, { key }, value);
  tracked.length = 0;

  const renamed = await renamePivot(PROJECT, "b", "  Bee ", value);
  assert.ok(renamed.ok);
  assert.equal(renamed.pivots.find((pivot) => pivot.key === "b")?.label, "Bee");

  const moved = await reorderPivot(PROJECT, "c", "up", value);
  assert.ok(moved.ok);
  assert.deepEqual(
    moved.pivots.map((pivot) => [pivot.key, pivot.position]),
    [
      ["a", 0],
      ["c", 1],
      ["b", 2],
    ],
  );
  assert.deepEqual(
    tracked.map((entry) => [entry.event, entry.properties.change]),
    [
      ["pivot_updated", "label"],
      ["pivot_updated", "position"],
    ],
  );
});

test("remove: the others close the gap, tracked as pivot_deleted", async () => {
  const db = await setup();
  const { value, tracked } = deps(db);
  await addPivot(PROJECT, { presetId: "end_user" }, value);
  await addPivot(PROJECT, { key: "b" }, value);
  await addPivot(PROJECT, { key: "c" }, value);
  tracked.length = 0;

  const result = await removePivot(PROJECT, "end_user", value);
  assert.ok(result.ok);
  assert.deepEqual(
    result.pivots.map((pivot) => [pivot.key, pivot.position]),
    [
      ["b", 0],
      ["c", 1],
    ],
  );
  assert.deepEqual(tracked[0]?.event, "pivot_deleted");
  assert.deepEqual(tracked[0]?.properties, {
    pivot_key: "end_user",
    preset_id: "end_user",
    pivot_count: 2,
  });
  assert.deepEqual(await removePivot(PROJECT, "end_user", value), {
    ok: false,
    error: PIVOT_SETTINGS_ERRORS.missing,
  });
});

test("the sixth pivot and a duplicate are refused, and nothing is written", async () => {
  const db = await setup();
  const { value, tracked } = deps(db);
  for (const key of ["a", "b", "c", "d", "e"]) await addPivot(PROJECT, { key }, value);
  tracked.length = 0;

  assert.deepEqual(await addPivot(PROJECT, { key: "f" }, value), {
    ok: false,
    error: PIVOT_SETTINGS_ERRORS.limit,
  });
  await removePivot(PROJECT, "e", value);
  assert.deepEqual(await addPivot(PROJECT, { key: "a" }, value), {
    ok: false,
    error: PIVOT_SETTINGS_ERRORS.duplicate,
  });
  assert.equal((await listPivots(PROJECT, db)).length, 4);
  assert.deepEqual(
    tracked.map((entry) => entry.event),
    ["pivot_deleted"],
  );
});

test("the store keeps the limit when two adds race past the domain check", async () => {
  const db = await setup();
  for (const [position, key] of ["a", "b", "c", "d", "e"].entries()) {
    assert.equal(
      await insertPivot(PROJECT, { key, label: key, presetId: null, position }, db),
      "inserted",
    );
  }
  assert.equal(
    await insertPivot(PROJECT, { key: "f", label: "f", presetId: null, position: 5 }, db),
    "limit",
  );
  assert.equal(
    await insertPivot(OTHER, { key: "a", label: "a", presetId: null, position: 0 }, db),
    "inserted",
  );
});

test("scoped to the person's project: another project, a non-member and a support session are refused", async () => {
  const db = await setup();
  await insertPivot(OTHER, { key: "theirs", label: "theirs", presetId: null, position: 0 }, db);

  const member = deps(db);
  assert.deepEqual(await addPivot(OTHER, { key: "x" }, member.value), {
    ok: false,
    error: PIVOT_SETTINGS_ERRORS.not_found,
  });
  assert.deepEqual(await removePivot(OTHER, "theirs", member.value), {
    ok: false,
    error: PIVOT_SETTINGS_ERRORS.not_found,
  });
  assert.deepEqual(await readPivots(OTHER, member.value), {
    ok: false,
    error: PIVOT_SETTINGS_ERRORS.not_found,
  });

  const outsider = deps(db, { member: false });
  assert.deepEqual(await addPivot(PROJECT, { key: "x" }, outsider.value), {
    ok: false,
    error: PIVOT_SETTINGS_ERRORS.not_found,
  });

  const support = deps(db, { restricted: true });
  assert.deepEqual(await addPivot(PROJECT, { key: "x" }, support.value), {
    ok: false,
    error: PIVOT_SETTINGS_ERRORS.restricted,
  });
  assert.ok((await readPivots(PROJECT, support.value)).ok);

  assert.deepEqual(await listPivots(PROJECT, db), []);
  assert.deepEqual(
    (await listPivots(OTHER, db)).map((pivot) => pivot.key),
    ["theirs"],
  );
  for (const entry of [member, outsider, support]) assert.deepEqual(entry.tracked, []);
});

test("invalid input is refused with its message", async () => {
  const db = await setup();
  const { value } = deps(db);
  assert.deepEqual(await addPivot(PROJECT, { key: "has space" }, value), {
    ok: false,
    error: PIVOT_SETTINGS_ERRORS.invalid_key,
  });
  assert.deepEqual(await addPivot(PROJECT, { presetId: "nope" }, value), {
    ok: false,
    error: PIVOT_SETTINGS_ERRORS.unknown_preset,
  });
  await addPivot(PROJECT, { key: "a" }, value);
  assert.deepEqual(await renamePivot(PROJECT, "a", "", value), {
    ok: false,
    error: PIVOT_SETTINGS_ERRORS.invalid_label,
  });
  assert.deepEqual(await renamePivot(PROJECT, "zzz", "Name", value), {
    ok: false,
    error: PIVOT_SETTINGS_ERRORS.missing,
  });
  assert.deepEqual(await reorderPivot(PROJECT, "zzz", "up", value), {
    ok: false,
    error: PIVOT_SETTINGS_ERRORS.missing,
  });
});
