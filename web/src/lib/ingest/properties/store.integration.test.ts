import assert from "node:assert/strict";
import { test } from "node:test";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";
import {
  clearIndexedAt,
  countUserIndexed,
  findTraceProperty,
  listTraceProperties,
  loadIndexedProperties,
  MAX_DETECTED_KEYS,
  recordPropertyKeys,
  setTracePropertyState,
} from "./store";

const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";

async function withTwoProjects() {
  const setup = await setupDb();
  await setup.client.exec(`
    insert into projects (id, organization_id, name, slug)
    values ('${OTHER_PROJECT}', '22222222-2222-4222-8222-222222222222', 'Other', 'other');
  `);
  return setup;
}

test("an unknown key is recorded detected, a standard one indexed under its canonical name", async () => {
  const { client, db } = await withTwoProjects();
  const recorded = await recordPropertyKeys(
    PROJECT_ID,
    [
      { name: "app.plan", source: "user", count: 3 },
      { name: "organization", source: "standard", count: 1 },
      { name: "user", source: "standard", count: 1 },
    ],
    db,
  );
  assert.deepEqual(
    recorded.sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "app.plan", state: "detected", created: true },
      { name: "organization", state: "indexed", created: true },
      { name: "user", state: "indexed", created: true },
    ],
  );
  assert.deepEqual(
    await recordPropertyKeys(PROJECT_ID, [{ name: "app.plan", source: "user", count: 2 }], db),
    [{ name: "app.plan", state: "detected", created: false }],
  );
  const listed = await listTraceProperties(PROJECT_ID, db);
  assert.deepEqual(
    listed.map(({ name, state, source, column, seenCount }) => ({
      name,
      state,
      source,
      column,
      seenCount,
    })),
    [
      { name: "organization", state: "indexed", source: "standard", column: null, seenCount: 1 },
      { name: "user", state: "indexed", source: "standard", column: "end_user_id", seenCount: 1 },
      { name: "app.plan", state: "detected", source: "user", column: null, seenCount: 5 },
    ],
  );
  assert.ok(listed[0]!.indexedAt instanceof Date);
  assert.equal(listed[2]!.indexedAt, null);
  assert.deepEqual([...(await loadIndexedProperties(PROJECT_ID, db))].sort(), [
    "organization",
    "user",
  ]);
  // Another project sees none of it.
  assert.deepEqual(await listTraceProperties(OTHER_PROJECT, db), []);
  assert.equal(await findTraceProperty(OTHER_PROJECT, "app.plan", db), null);
  await client.close();
});

test("a project keeps at most 200 keys of its own; standard ones still come in", async () => {
  const { client, db } = await withTwoProjects();
  const keys = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `app.k${String(from + i).padStart(3, "0")}`,
      source: "user" as const,
      count: 1,
    }));
  await recordPropertyKeys(PROJECT_ID, keys(0, 150), db);
  const second = await recordPropertyKeys(
    PROJECT_ID,
    [...keys(140, 70), { name: "release", source: "standard", count: 1 }],
    db,
  );
  // 10 known keys, 50 new ones up to the bound, and the standard one.
  assert.equal(second.length, 61);
  const listed = await listTraceProperties(PROJECT_ID, db);
  assert.equal(listed.filter((p) => p.source === "user").length, MAX_DETECTED_KEYS);
  assert.ok(listed.some((p) => p.name === "release" && p.state === "indexed"));
  // A known key is still counted at the bound.
  await recordPropertyKeys(PROJECT_ID, keys(0, 1), db);
  assert.equal((await findTraceProperty(PROJECT_ID, "app.k000", db))?.seenCount, 2);
  // The other project has its own room.
  assert.equal((await recordPropertyKeys(OTHER_PROJECT, keys(0, 5), db)).length, 5);
  await client.close();
});

test("a state change is the project's own, and a standard property turned off stays off", async () => {
  const { client, db } = await withTwoProjects();
  await recordPropertyKeys(
    PROJECT_ID,
    [
      { name: "app.plan", source: "user", count: 1 },
      { name: "organization", source: "standard", count: 1 },
    ],
    db,
  );
  assert.equal(await setTracePropertyState(OTHER_PROJECT, "app.plan", "indexed", db), null);
  const indexed = await setTracePropertyState(PROJECT_ID, "app.plan", "indexed", db);
  assert.equal(indexed?.state, "indexed");
  assert.ok(indexed?.indexedAt instanceof Date);
  assert.equal(await countUserIndexed(PROJECT_ID, db), 1);
  assert.equal(await countUserIndexed(OTHER_PROJECT, db), 0);

  await setTracePropertyState(PROJECT_ID, "organization", "detected", db);
  await recordPropertyKeys(
    PROJECT_ID,
    [{ name: "organization", source: "standard", count: 1 }],
    db,
  );
  const organization = await findTraceProperty(PROJECT_ID, "organization", db);
  assert.equal(organization?.state, "detected");
  // Its values stay until they are erased.
  assert.ok(organization?.indexedAt instanceof Date);
  await clearIndexedAt(PROJECT_ID, "organization", db);
  assert.equal((await findTraceProperty(PROJECT_ID, "organization", db))?.indexedAt, null);
  await client.close();
});
