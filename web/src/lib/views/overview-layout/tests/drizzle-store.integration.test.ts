import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  changeOverviewLayout,
  type LayoutDeps,
  readOverviewLayout,
  undoOverviewChange,
} from "../actions";
import { createDrizzleOverviewLayoutStore } from "../adapters/drizzle-store";
import { type LayoutRecord, type LayoutWrite, NO_RECORD, nextChange } from "../domain/history";
import { DEFAULT_LAYOUT, type OverviewLayoutChange, WIDGET_CATALOG } from "../domain/layout";
import { changeArrangement, readArrangement } from "../domain/stored";

const ORG = "22222222-2222-4222-8222-222222222222";
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "33333333-3333-4333-8333-333333333333";
const MIGRATIONS = join(import.meta.dirname, "../../../platform/db/migrations");
const REMOVE: OverviewLayoutChange = { kind: "remove", widget: "topology" };
const REMOVE_HEALTH: OverviewLayoutChange = { kind: "remove", widget: "health" };

const layoutOf = ({ layout }: LayoutRecord) => readArrangement(layout, WIDGET_CATALOG).layout;
const changed =
  (change: OverviewLayoutChange) =>
  (record: LayoutRecord): LayoutWrite | null =>
    nextChange(
      record,
      changeArrangement(readArrangement(record.layout, WIDGET_CATALOG), change, WIDGET_CATALOG),
      WIDGET_CATALOG,
      { kind: "change", source: { kind: "web" }, summary: change.kind },
    );
const height = (n: number): OverviewLayoutChange => ({
  kind: "resize",
  widget: "topology",
  w: 12,
  h: 7 + (n % 2),
});

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
  assert.deepEqual(await store.read(key), NO_RECORD);
  const after = await store.update(key, changed(REMOVE));
  assert.deepEqual(after.layout, changed(REMOVE)(NO_RECORD)?.layout);
  assert.deepEqual(await store.read(key), after);
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

test("a row nobody can read is the default, and an update that gives null leaves it", async () => {
  const { pg, store } = await setup();
  const key = { projectId: P1, personId: "ana" };
  await pg.exec(
    `insert into overview_layouts (project_id, person_id, layout) values ('${P1}', 'ana', '{"version": 99}')`,
  );
  assert.deepEqual(layoutOf(await store.read(key)), DEFAULT_LAYOUT);
  await store.update(key, () => null);
  assert.deepEqual(await store.read(key), { layout: { version: 99 }, entries: [] });
  await pg.close();
});

test("the rows go with their project", async () => {
  const { pg, store } = await setup();
  for (const projectId of [P1, P2])
    await store.update({ projectId, personId: "ana" }, changed(REMOVE));
  await pg.exec(`delete from projects where id = '${P1}'`);
  for (const table of ["overview_layouts", "overview_layout_changes"]) {
    const { rows } = await pg.query(`select project_id from ${table}`);
    assert.deepEqual(rows, [{ project_id: P2 }], table);
  }
  await pg.close();
});

test("an entry is stored whole, and is nobody else's", async () => {
  const { pg, store } = await setup();
  const key = { projectId: P1, personId: "ana" };
  await store.update(key, changed(REMOVE));
  const { entries, layout } = await store.update(key, (record) => {
    const write = changed(REMOVE_HEALTH)(record);
    return write && { ...write, source: { kind: "mcp", client: "claude-code" }, undoes: 1 };
  });
  const [{ at, before, ...entry }, first] = entries;
  assert.ok(at instanceof Date);
  assert.deepEqual(before, first.layout);
  assert.deepEqual(entry, {
    seq: 2,
    kind: "change",
    source: { kind: "mcp", client: "claude-code" },
    summary: "remove",
    undoes: 1,
    layout,
  });
  assert.deepEqual([first.seq, first.before, first.source], [1, null, { kind: "web" }]);
  for (const other of [
    { projectId: P1, personId: "ben" },
    { projectId: P2, personId: "ana" },
  ])
    assert.deepEqual(await store.read(other), NO_RECORD);
  await pg.close();
});

test("the 26th change drops the oldest, for that person only", async () => {
  const { pg, store } = await setup();
  const key = { projectId: P1, personId: "ana" };
  await store.update({ projectId: P1, personId: "ben" }, changed(REMOVE));
  for (let n = 1; n <= 30; n += 1) await store.update(key, changed(height(n)));
  const { entries } = await store.read(key);
  assert.deepEqual(
    entries.map(({ seq }) => seq),
    Array.from({ length: 25 }, (_, index) => 30 - index),
  );
  const { rows } = await pg.query("select count(*)::int as count from overview_layout_changes");
  assert.deepEqual(rows, [{ count: 26 }], "nothing older is stored");
  await pg.close();
});

test("a change, its entry and the drop of the oldest are one transaction", async () => {
  const { pg, store } = await setup();
  const key = { projectId: P1, personId: "ana" };
  for (let n = 1; n <= 25; n += 1) await store.update(key, changed(height(n)));
  const before = await store.read(key);
  await pg.exec(`create function refuse() returns trigger language plpgsql as
    $$ begin raise exception 'no'; end $$;
    create trigger refuse before delete on overview_layout_changes for each row execute function refuse()`);
  await assert.rejects(store.update(key, changed(REMOVE)));
  assert.deepEqual(await store.read(key), before);
  await pg.close();
});

test("two writers with one base: the first is stored, the second is refused and writes nothing", async () => {
  const { pg, store } = await setup();
  const deps: LayoutDeps = {
    reader: async () => ({ kind: "person", projectId: P1, personId: "ana", restricted: false }),
    store: () => store,
    offered: async () => WIDGET_CATALOG,
    source: async () => ({ kind: "web" }),
  };
  const read = await readOverviewLayout(P1, deps);
  assert.ok(read.ok);
  const results = await Promise.all([
    changeOverviewLayout(P1, REMOVE, deps, read.revision),
    changeOverviewLayout(P1, REMOVE_HEALTH, deps, read.revision),
  ]);
  assert.deepEqual(results.map(({ ok }) => ok).toSorted(), [false, true]);
  const refused = results.find(({ ok }) => !ok);
  assert.ok(refused && !refused.ok && refused.reason === "stale");
  const now = await readOverviewLayout(P1, deps);
  assert.ok(now.ok);
  assert.deepEqual(refused.current, {
    layout: now.layout,
    revision: now.revision,
    undo: now.undo,
  });
  assert.equal((await store.read({ projectId: P1, personId: "ana" })).entries.length, 1);

  // An undo and a change at the same time are two writers too.
  const pair = await Promise.all([
    undoOverviewChange(P1, deps, now.revision),
    changeOverviewLayout(P1, { kind: "reset" }, deps, now.revision),
  ]);
  assert.deepEqual(pair.map(({ ok }) => ok).toSorted(), [false, true]);
  await pg.close();
});

test("the migration applies on a database that already has projects", async () => {
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .toSorted();
  const last = files.findIndex((file) => file.endsWith("_overview_layouts.sql"));
  const history = files.findIndex((file) => file.endsWith("_overview_layout_changes.sql"));
  const apply = (pg: PGlite, file: string) => pg.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  const pg = new PGlite();
  for (const file of files.slice(0, last)) await apply(pg, file);
  await seedProjects(pg);
  await apply(pg, files[last]);
  const { rows } = await pg.query<{ count: number }>("select count(*)::int as count from projects");
  assert.equal(rows[0].count, 2);

  // The history comes after layouts that have none, and a build without it can still write them.
  const { layout } = changed(REMOVE)(NO_RECORD) ?? {};
  const write = () =>
    pg.query(
      `insert into overview_layouts (project_id, person_id, layout) values ($1, 'ana', $2)
       on conflict (project_id, person_id) do update set layout = excluded.layout`,
      [P1, JSON.stringify(layout)],
    );
  await write();
  await apply(pg, files[history]);
  await write();
  const key = { projectId: P1, personId: "ana" };
  const store = createDrizzleOverviewLayoutStore(
    drizzle(pg) as unknown as Parameters<typeof createDrizzleOverviewLayoutStore>[0],
  );
  assert.deepEqual(await store.read(key), { layout, entries: [] });
  const { entries } = await store.update(key, changed(REMOVE_HEALTH));
  assert.deepEqual(entries[0].before, layout, "its first undo goes back to what was there");
  await pg.close();
});
