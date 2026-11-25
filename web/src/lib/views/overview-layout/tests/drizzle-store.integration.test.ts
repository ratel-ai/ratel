import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { createDrizzleOverviewLayoutStore } from "../adapters/drizzle-store";
import { DEFAULT_LAYOUT, type OverviewLayoutChange, WIDGET_CATALOG } from "../domain/layout";
import { changeArrangement, readArrangement, storeArrangement } from "../domain/stored";

const ORG = "22222222-2222-4222-8222-222222222222";
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "33333333-3333-4333-8333-333333333333";
const MIGRATIONS = join(import.meta.dirname, "../../../platform/db/migrations");
const REMOVE: OverviewLayoutChange = { kind: "remove", widget: "topology" };
const REMOVE_HEALTH: OverviewLayoutChange = { kind: "remove", widget: "health" };

const layoutOf = (stored: unknown) => readArrangement(stored, WIDGET_CATALOG).layout;
const changed = (change: OverviewLayoutChange) => (stored: unknown) =>
  storeArrangement(
    changeArrangement(readArrangement(stored, WIDGET_CATALOG), change, WIDGET_CATALOG),
  );

async function setup() {
  const pg = await createMigratedPGlite();
  await seedProjects(pg);
  const db = drizzle(pg) as unknown as Parameters<typeof createDrizzleOverviewLayoutStore>[0];
  return { pg, store: createDrizzleOverviewLayoutStore(db) };
}

const seedProjects = (pg: PGlite) =>
  pg.exec(`insert into projects (id, organization_id, name, slug) values
    ('${P1}', '${ORG}', 'One', 'one'), ('${P2}', '${ORG}', 'Two', 'two')`);

test("no row reads as the default, and a change is read back", async () => {
  const { pg, store } = await setup();
  const key = { projectId: P1, personId: "ana" };
  assert.equal(await store.read(key), undefined);
  await store.update(key, changed(REMOVE));
  assert.deepEqual(await store.read(key), changed(REMOVE)(undefined));
  await pg.close();
});

test("another person and another project keep their own layout", async () => {
  const { pg, store } = await setup();
  await store.update({ projectId: P1, personId: "ana" }, changed(REMOVE));
  assert.deepEqual(layoutOf(await store.read({ projectId: P1, personId: "ben" })), DEFAULT_LAYOUT);
  assert.deepEqual(layoutOf(await store.read({ projectId: P2, personId: "ana" })), DEFAULT_LAYOUT);
  await pg.close();
});

test("two changes both apply, in one row", async () => {
  const { pg, store } = await setup();
  const key = { projectId: P1, personId: "ana" };
  await Promise.all([
    store.update(key, changed(REMOVE)),
    store.update(key, changed(REMOVE_HEALTH)),
  ]);
  const removed = layoutOf(await store.read(key))
    .filter((widget) => widget.removed)
    .map(({ id }) => id);
  assert.deepEqual(removed.toSorted(), ["health", "topology"]);
  const { rows } = await pg.query("select 1 from overview_layouts");
  assert.equal(rows.length, 1);
  await pg.close();
});

test("a row nobody can read is the default, and the next change replaces it", async () => {
  const { pg, store } = await setup();
  const key = { projectId: P1, personId: "ana" };
  await pg.exec(
    `insert into overview_layouts (project_id, person_id, layout) values ('${P1}', 'ana', '{"version": 99}')`,
  );
  assert.deepEqual(layoutOf(await store.read(key)), DEFAULT_LAYOUT);
  await store.update(key, changed(REMOVE));
  assert.equal(layoutOf(await store.read(key)).filter(({ removed }) => removed).length, 1);
  await pg.close();
});

test("the rows go with their project", async () => {
  const { pg, store } = await setup();
  for (const projectId of [P1, P2])
    await store.update({ projectId, personId: "ana" }, changed(REMOVE));
  await pg.exec(`delete from projects where id = '${P1}'`);
  const { rows } = await pg.query("select project_id from overview_layouts");
  assert.deepEqual(rows, [{ project_id: P2 }]);
  await pg.close();
});

test("the migration applies on a database that already has projects", async () => {
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .toSorted();
  const last = files.findIndex((file) => file.endsWith("_overview_layouts.sql"));
  const apply = (pg: PGlite, file: string) => pg.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  const pg = new PGlite();
  for (const file of files.slice(0, last)) await apply(pg, file);
  await seedProjects(pg);
  await apply(pg, files[last]);
  const { rows } = await pg.query<{ count: number }>("select count(*)::int as count from projects");
  assert.equal(rows[0].count, 2);
  await pg.close();
});
