import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changeOverviewLayout,
  type LayoutDeps,
  type LayoutReader,
  readOverviewHistory,
  readOverviewLayout,
  restoreOverviewLayout,
  undoOverviewChange,
} from "../actions";
import { KEPT_CHANGES, type LayoutRecord, NO_RECORD, postedRevision } from "../domain/history";
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
  const rows = new Map<string, LayoutRecord>();
  const calls: string[] = [];
  const at = ({ projectId, personId }: { projectId: string; personId: string }) =>
    `${projectId}/${personId}`;
  const store: OverviewLayoutStore = {
    async read(key) {
      calls.push(`read ${at(key)}`);
      return rows.get(at(key)) ?? NO_RECORD;
    },
    async update(key, next) {
      calls.push(`update ${at(key)}`);
      const current = rows.get(at(key)) ?? NO_RECORD;
      const entry = next(current);
      if (!entry) return current;
      const record = {
        layout: entry.layout,
        entries: [{ ...entry, at: new Date() }, ...current.entries].slice(0, KEPT_CHANGES),
      };
      rows.set(at(key), record);
      return record;
    },
  };
  return { store, calls, rows };
}

const deps = (reader: LayoutReader | null, { store }: ReturnType<typeof memory>): LayoutDeps => ({
  reader: async () => reader,
  store: () => store,
  offered: async () => WIDGET_CATALOG,
  dashboardWidget: async () => null,
  source: async () => ({ kind: "web" }),
});

const DEFAULT = { layout: DEFAULT_LAYOUT, revision: "0.0", undo: null };
const change = (what: unknown, at: LayoutDeps) => changeOverviewLayout("p1", what, at, null);

test("a person's change is what they read next", async () => {
  const at = deps(PERSON, memory());
  const changed = await change(REMOVE, at);
  assert.ok(changed.ok);
  const read = await readOverviewLayout("p1", at);
  assert.ok(read.ok && sameLayout(read.layout, changed.layout));
});

test("without access to the project nothing is read or written", async () => {
  const db = memory();
  const none = deps(null, db);
  const refused = { ok: false, reason: "not_found" };
  assert.deepEqual(await readOverviewLayout("p1", none), refused);
  assert.deepEqual(await change(REMOVE, none), refused);
  assert.deepEqual(db.calls, []);
});

test("an API key reads the default and cannot write", async () => {
  const db = memory();
  const key = deps({ kind: "api-key" }, db);
  assert.deepEqual(await readOverviewLayout("p1", key), { ok: true, ...DEFAULT });
  assert.deepEqual(await change(REMOVE, key), { ok: false, reason: "api_key" });
  assert.deepEqual(db.calls, []);
});

test("a support session reads the default and cannot write, and the personal layout stays", async () => {
  const db = memory();
  assert.ok((await change(REMOVE, deps(PERSON, db))).ok);
  const personal = await readOverviewLayout("p1", deps(PERSON, db));
  db.calls.length = 0;
  const support = deps({ ...PERSON, restricted: true }, db);
  assert.deepEqual(await readOverviewLayout("p1", support), { ok: true, ...DEFAULT });
  assert.deepEqual(await change(REMOVE, support), {
    ok: false,
    reason: "support_session",
  });
  assert.deepEqual(db.calls, [], "the store is not read");
  assert.deepEqual(await readOverviewLayout("p1", deps(PERSON, db)), personal);
});

test("a change that is not one writes nothing", async () => {
  const db = memory();
  assert.deepEqual(await change({ kind: "remove", widget: "x" }, deps(PERSON, db)), {
    ok: false,
    reason: "invalid",
  });
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
  assert.ok((await change(REMOVE, deps(PERSON, db))).ok);
  const read = await readOverviewLayout("p1", without);
  assert.ok(read.ok && read.layout.every(({ id }) => id !== "topology"));
  assert.deepEqual(await change(REMOVE, without), {
    ok: false,
    reason: "invalid",
  });
  assert.ok((await change({ kind: "remove", widget: "health" }, without)).ok);
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
    db.rows.set("p1/user_1", { layout: stored, entries: [] });
    const at = deps(PERSON, db);
    const read = await readOverviewLayout("p1", at);
    assert.ok(read.ok && read.undo === null);
    assert.deepEqual(read.layout, DEFAULT_LAYOUT);
    const move = { kind: "move", widget: "attention", x: 0, y: 0 };
    for (const what of [REMOVE, move, { kind: "arrange", places: [] }])
      assert.deepEqual(await change(what, at), {
        ok: false,
        reason: "unreadable",
      });
    assert.equal(db.rows.get("p1/user_1")?.layout, stored, "not overwritten");
    assert.ok((await change({ kind: "reset" }, at)).ok);
    assert.ok((await change(REMOVE, at)).ok, "readable again");
  }
});

test("the page offers no save when the layout was not read", async () => {
  const db = memory();
  const thrown = deps(PERSON, {
    ...db,
    store: { ...db.store, read: () => Promise.reject(new Error("statement timeout")) },
  });
  const unsaved = { ...DEFAULT, revision: "", read: false };
  assert.deepEqual(await pageLayout("p1", thrown), unsaved);
  assert.deepEqual(await pageLayout("p1", deps(null, db)), unsaved);
  assert.deepEqual(await pageLayout("p1", deps(PERSON, db)), { ...DEFAULT, read: true });
});

// — The history ——————————————————————————————————————————————————————————————

async function historyOf(at: LayoutDeps) {
  const history = await readOverviewHistory("p1", at);
  assert.ok(history.ok);
  return history;
}

async function revisionNow(at: LayoutDeps) {
  return (await historyOf(at)).snapshot.revision;
}

const undo = async (at: LayoutDeps) => undoOverviewChange("p1", at, await revisionNow(at));
const restore = async (id: number, at: LayoutDeps) =>
  restoreOverviewLayout("p1", id, at, await revisionNow(at));
const REMOVE_HEALTH = { kind: "remove", widget: "health" };

async function removedOf(at: LayoutDeps) {
  const read = await readOverviewLayout("p1", at);
  assert.ok(read.ok);
  return read.layout
    .filter(({ removed }) => removed)
    .map(({ id }) => id)
    .toSorted();
}

test("each change is an entry: who, where, what and the layout after it", async () => {
  const at = deps(PERSON, memory());
  const first = await change(REMOVE, at);
  const mcp: LayoutDeps = { ...at, source: async () => ({ kind: "mcp", client: "claude-code" }) };
  const second = await change(REMOVE_HEALTH, mcp);
  assert.ok(first.ok && second.ok);
  const { entries, snapshot } = await historyOf(at);
  assert.deepEqual(
    entries.map(({ at: time, ...entry }) => ({ ...entry, timed: time instanceof Date })),
    [
      {
        id: 2,
        kind: "change",
        personId: "user_1",
        source: { kind: "mcp", client: "claude-code" },
        summary: "Removed Health score",
        layout: second.layout,
        current: true,
        readable: true,
        timed: true,
      },
      {
        id: 1,
        kind: "change",
        personId: "user_1",
        source: { kind: "web" },
        summary: "Removed Agents and MCP servers",
        layout: first.layout,
        current: false,
        readable: true,
        timed: true,
      },
    ],
  );
  assert.equal(snapshot.undo, "Removed Health score");
  assert.equal(second.revision, snapshot.revision);
});

test("a save that changes nothing is no entry, and writes nothing", async () => {
  const db = memory();
  const at = deps(PERSON, db);
  const same = {
    kind: "arrange",
    places: DEFAULT_LAYOUT.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
  };
  for (const what of [{ kind: "reset" }, same, { kind: "add", widget: "topology" }])
    assert.deepEqual(await change(what, at), { ok: true, changed: null, ...DEFAULT });
  assert.equal(db.rows.size, 0);
});

test("a drag is one entry that names the widget the person took", async () => {
  const at = deps(PERSON, memory());
  const places = [
    { id: "topology", x: 0, y: 0, w: 12, h: 7 },
    { id: "metrics", x: 0, y: 7, w: 12, h: 3 },
    { id: "health", x: 0, y: 10, w: 4, h: 6 },
    { id: "attention", x: 4, y: 10, w: 8, h: 6 },
  ];
  await change({ kind: "arrange", widget: "topology", places }, at);
  await change(
    {
      kind: "arrange",
      widget: "health",
      places: places.map((place) => (place.id === "health" ? { ...place, h: 7 } : place)),
    },
    at,
  );
  const { entries } = await historyOf(at);
  assert.deepEqual(
    entries.map(({ summary }) => summary),
    ["Resized Health score", "Moved Agents and MCP servers"],
  );
});

test("undo takes back the latest change as an entry, and the next one goes further back", async () => {
  const at = deps(PERSON, memory());
  await change(REMOVE, at);
  await change(REMOVE_HEALTH, at);
  const first = await undo(at);
  assert.ok(first.ok);
  assert.equal(first.changed, "Took back: Removed Health score");
  assert.equal(first.undo, "Removed Agents and MCP servers");
  assert.deepEqual(await removedOf(at), ["topology"]);
  assert.ok((await undo(at)).ok);
  assert.deepEqual(await removedOf(at), []);
  assert.deepEqual(await undo(at), { ok: false, reason: "nothing_to_undo" });
  const { entries } = await historyOf(at);
  assert.deepEqual(
    entries.map(({ kind }) => kind),
    ["undo", "undo", "change", "change"],
  );
  // A change after the undos is the latest one again.
  await change(REMOVE_HEALTH, at);
  assert.ok((await undo(at)).ok);
  assert.deepEqual(await removedOf(at), []);
});

test("restore goes to any kept state as an entry, and undo takes the restore back", async () => {
  const at = deps(PERSON, memory());
  await change(REMOVE, at);
  await change(REMOVE_HEALTH, at);
  await change({ kind: "reset" }, at);
  const restored = await restore(1, at);
  assert.ok(restored.ok);
  assert.equal(restored.changed, "Restored the layout after: Removed Agents and MCP servers");
  assert.deepEqual(await removedOf(at), ["topology"]);
  const [latest] = (await historyOf(at)).entries;
  assert.deepEqual([latest.id, latest.kind, latest.current], [4, "restore", true]);
  const current = (await historyOf(at)).entries.filter((entry) => entry.current);
  assert.deepEqual(
    current.map(({ id }) => id),
    [4, 1],
    "each entry with the layout of now",
  );
  assert.ok((await undo(at)).ok);
  assert.deepEqual(await removedOf(at), []);
  const again = await restore(4, at);
  assert.ok(again.ok && again.changed === restored.changed, "no words inside words");
  assert.ok((await undo(at)).ok);
  const same = await restore(7, at);
  assert.ok(same.ok && same.changed === null, "already there");
  assert.deepEqual(await restore(99, at), { ok: false, reason: "not_kept" });
  assert.deepEqual(await restore(Number.NaN, at), { ok: false, reason: "not_kept" });
});

test("what a page posts as its revision is never null, which would skip the check", async () => {
  const at = deps(PERSON, memory());
  await change(REMOVE, at);
  for (const posted of [null, undefined, 1, {}]) {
    const result = await changeOverviewLayout("p1", REMOVE, at, postedRevision(posted));
    assert.ok(!result.ok && result.reason === "stale", String(posted));
  }
  assert.equal(postedRevision("1.a"), "1.a");
});

test("a change, an undo and a restore on a stale base are refused with what is there now", async () => {
  const db = memory();
  const at = deps(PERSON, db);
  await change(REMOVE, at);
  const base = await revisionNow(at);
  await change(REMOVE_HEALTH, at);
  const before = db.rows.get("p1/user_1");
  const { snapshot } = await historyOf(at);
  for (const stale of [base, "", "0.0"])
    for (const run of [
      () => changeOverviewLayout("p1", { kind: "reset" }, at, stale),
      () => undoOverviewChange("p1", at, stale),
      () => restoreOverviewLayout("p1", 1, at, stale),
    ])
      assert.deepEqual(await run(), { ok: false, reason: "stale", current: snapshot });
  assert.equal(db.rows.get("p1/user_1"), before);
});

test("support sessions and API keys cannot undo or restore, and they read no history", async () => {
  const db = memory();
  const at = deps(PERSON, db);
  await change(REMOVE, at);
  const base = await revisionNow(at);
  db.calls.length = 0;
  for (const [reader, reason] of [
    [null, "not_found"],
    [{ kind: "api-key" }, "api_key"],
    [{ ...PERSON, restricted: true }, "support_session"],
  ] as const) {
    const refused = deps(reader, db);
    for (const result of [
      await undoOverviewChange("p1", refused, base),
      await restoreOverviewLayout("p1", 1, refused, base),
      await readOverviewHistory("p1", refused),
    ])
      assert.deepEqual(result, { ok: false, reason });
  }
  assert.deepEqual(db.calls, [], "the store is not read");
  const other = deps({ ...PERSON, personId: "user_2" }, db);
  assert.deepEqual((await historyOf(other)).entries, []);
});

test("a change that a build without the history made is stale for an old base, and undo takes it back", async () => {
  const db = memory();
  const at = deps(PERSON, db);
  await change(REMOVE, at);
  const base = await revisionNow(at);
  const record = db.rows.get("p1/user_1") ?? NO_RECORD;
  db.rows.set("p1/user_1", { ...record, layout: { version: 1, widgets: [WIDGET] } });
  const stale = await undoOverviewChange("p1", at, base);
  assert.ok(!stale.ok && stale.reason === "stale");
  assert.equal((await historyOf(at)).entries[0].current, false);
  assert.ok((await undo(at)).ok);
  assert.deepEqual(await removedOf(at), ["topology"]);
  assert.ok((await undo(at)).ok);
  assert.deepEqual(await removedOf(at), []);
});

test("a layout or an entry this build cannot read is never overwritten by an undo or a restore", async () => {
  const db = memory();
  const at = deps(PERSON, db);
  await change(REMOVE, at);
  const record = db.rows.get("p1/user_1") ?? NO_RECORD;
  const later = { version: 2 };
  db.rows.set("p1/user_1", { ...record, layout: later });
  assert.deepEqual(await undo(at), { ok: false, reason: "unreadable" });
  assert.deepEqual(await restore(1, at), { ok: false, reason: "unreadable" });
  assert.equal(db.rows.get("p1/user_1")?.layout, later);
  const reset = await change({ kind: "reset" }, at);
  assert.ok(reset.ok && reset.undo === null, "Undo is not offered where it must refuse");
  assert.deepEqual(await undo(at), { ok: false, reason: "unreadable_entry" });
  assert.ok((await restore(1, at)).ok, "the entry before it is still readable");
});
