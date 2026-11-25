import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changeOverviewLayout,
  type LayoutDeps,
  type LayoutReader,
  readOverviewLayout,
} from "../actions";
import { DEFAULT_LAYOUT, sameLayout, WIDGET_CATALOG } from "../domain/layout";
import type { OverviewLayoutStore } from "../ports/store";
import { pageLayout, webLayoutReader } from "../readers";

const REMOVE = { kind: "remove", widget: "topology" };
const WIDGET = { id: "metrics", x: 0, y: 0, w: 4, h: 3, hidden: false };
const PERSON: LayoutReader = {
  kind: "person",
  projectId: "p1",
  personId: "user_1",
  restricted: false,
};

/** A store in memory that counts its calls. */
function memory() {
  const rows = new Map<string, unknown>();
  const calls: string[] = [];
  const at = ({ projectId, personId }: { projectId: string; personId: string }) =>
    `${projectId}/${personId}`;
  const store: OverviewLayoutStore = {
    async read(key) {
      calls.push(`read ${at(key)}`);
      return rows.get(at(key));
    },
    async update(key, next) {
      calls.push(`update ${at(key)}`);
      const layout = next(rows.get(at(key)));
      if (layout) rows.set(at(key), layout);
    },
  };
  return { store, calls, rows };
}

const deps = (reader: LayoutReader | null, { store }: ReturnType<typeof memory>): LayoutDeps => ({
  reader: async () => reader,
  store: () => store,
  offered: async () => WIDGET_CATALOG,
});

test("a person's change is what they read next", async () => {
  const at = deps(PERSON, memory());
  const changed = await changeOverviewLayout("p1", REMOVE, at);
  assert.ok(changed.ok);
  const read = await readOverviewLayout("p1", at);
  assert.ok(read.ok && sameLayout(read.layout, changed.layout));
});

test("without access to the project nothing is read or written", async () => {
  const db = memory();
  const none = deps(null, db);
  const refused = { ok: false, reason: "not_found" };
  assert.deepEqual(await readOverviewLayout("p1", none), refused);
  assert.deepEqual(await changeOverviewLayout("p1", REMOVE, none), refused);
  assert.deepEqual(db.calls, []);
});

test("an API key reads the default and cannot write", async () => {
  const db = memory();
  const key = deps({ kind: "api-key" }, db);
  assert.deepEqual(await readOverviewLayout("p1", key), { ok: true, layout: DEFAULT_LAYOUT });
  assert.deepEqual(await changeOverviewLayout("p1", REMOVE, key), { ok: false, reason: "api_key" });
  assert.deepEqual(db.calls, []);
});

test("a support session reads the default and cannot write, and the personal layout stays", async () => {
  const db = memory();
  assert.ok((await changeOverviewLayout("p1", REMOVE, deps(PERSON, db))).ok);
  const personal = await readOverviewLayout("p1", deps(PERSON, db));
  db.calls.length = 0;
  const support = deps({ ...PERSON, restricted: true }, db);
  assert.deepEqual(await readOverviewLayout("p1", support), { ok: true, layout: DEFAULT_LAYOUT });
  assert.deepEqual(await changeOverviewLayout("p1", REMOVE, support), {
    ok: false,
    reason: "support_session",
  });
  assert.deepEqual(db.calls, [], "the store is not read");
  assert.deepEqual(await readOverviewLayout("p1", deps(PERSON, db)), personal);
});

test("a change that is not one writes nothing", async () => {
  const db = memory();
  assert.deepEqual(
    await changeOverviewLayout("p1", { kind: "remove", widget: "x" }, deps(PERSON, db)),
    {
      ok: false,
      reason: "invalid",
    },
  );
  assert.deepEqual(db.calls, []);
});

test("on the web the person is the session user's external id, in the project's scope", async () => {
  const scope = async (id: string) =>
    id === "p1" ? { project: { id }, user: { externalId: "user_1" } } : null;
  const reader = webLayoutReader({ scope, restricted: async () => true });
  assert.deepEqual(await reader("p1"), { ...PERSON, restricted: true });
  assert.equal(await reader("p2"), null);
});

test("an offered list comes in: the default, the refusal and the kept entry follow it", async () => {
  const db = memory();
  const without = {
    ...deps(PERSON, db),
    offered: async () => WIDGET_CATALOG.filter(({ id }) => id !== "topology"),
  };
  assert.ok((await changeOverviewLayout("p1", REMOVE, deps(PERSON, db))).ok);
  const read = await readOverviewLayout("p1", without);
  assert.ok(read.ok && read.layout.every(({ id }) => id !== "topology"));
  assert.deepEqual(await changeOverviewLayout("p1", REMOVE, without), {
    ok: false,
    reason: "invalid",
  });
  assert.ok((await changeOverviewLayout("p1", { kind: "remove", widget: "health" }, without)).ok);
  const again = await readOverviewLayout("p1", deps(PERSON, db));
  assert.ok(again.ok && again.layout.find(({ id }) => id === "topology")?.removed);
});

test("a stored row this build cannot read stays as it is, until the person resets", async () => {
  const whole = { version: 1, widgets: [] };
  for (const stored of [
    { ...whole, version: 2 },
    { version: 1, widgets: "?" },
    { version: 1, widgets: [WIDGET, WIDGET] },
  ]) {
    const db = memory();
    db.rows.set("p1/user_1", stored);
    const at = deps(PERSON, db);
    assert.deepEqual(await readOverviewLayout("p1", at), { ok: true, layout: DEFAULT_LAYOUT });
    const move = { kind: "move", widget: "attention", x: 0, y: 0 };
    for (const change of [REMOVE, move, { kind: "arrange", places: [] }])
      assert.deepEqual(await changeOverviewLayout("p1", change, at), {
        ok: false,
        reason: "unreadable",
      });
    assert.equal(db.rows.get("p1/user_1"), stored, "not overwritten");
    assert.ok((await changeOverviewLayout("p1", { kind: "reset" }, at)).ok);
    assert.ok((await changeOverviewLayout("p1", REMOVE, at)).ok, "readable again");
  }
});

test("the page offers no save when the layout was not read", async () => {
  const db = memory();
  const thrown = deps(PERSON, {
    ...db,
    store: { ...db.store, read: () => Promise.reject(new Error("statement timeout")) },
  });
  const unsaved = { layout: DEFAULT_LAYOUT, read: false };
  assert.deepEqual(await pageLayout("p1", thrown), unsaved);
  assert.deepEqual(await pageLayout("p1", deps(null, db)), unsaved);
  assert.deepEqual(await pageLayout("p1", deps(PERSON, db)), { ...unsaved, read: true });
});
