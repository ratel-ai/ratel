import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changeOverviewLayout,
  type LayoutDeps,
  type LayoutReader,
  readOverviewLayout,
} from "../actions";
import { DEFAULT_LAYOUT, type OverviewLayout, sameLayout } from "../domain/layout";
import type { OverviewLayoutStore } from "../ports/store";
import { webLayoutReader } from "../readers";

const HIDE = { kind: "hide", widget: "topology" };
const PERSON: LayoutReader = {
  kind: "person",
  projectId: "p1",
  personId: "user_1",
  restricted: false,
};

/** A store in memory that counts its calls. */
function memory() {
  const rows = new Map<string, OverviewLayout>();
  const calls: string[] = [];
  const at = ({ projectId, personId }: { projectId: string; personId: string }) =>
    `${projectId}/${personId}`;
  const store: OverviewLayoutStore = {
    async read(key) {
      calls.push(`read ${at(key)}`);
      return rows.get(at(key)) ?? DEFAULT_LAYOUT;
    },
    async update(key, next) {
      calls.push(`update ${at(key)}`);
      const layout = next(rows.get(at(key)) ?? DEFAULT_LAYOUT);
      rows.set(at(key), layout);
      return layout;
    },
  };
  return { store, calls };
}

const deps = (reader: LayoutReader | null, { store }: ReturnType<typeof memory>): LayoutDeps => ({
  reader: async () => reader,
  store: () => store,
});

test("a person's change is what they read next", async () => {
  const at = deps(PERSON, memory());
  const changed = await changeOverviewLayout("p1", HIDE, at);
  assert.ok(changed.ok);
  const read = await readOverviewLayout("p1", at);
  assert.ok(read.ok && sameLayout(read.layout, changed.layout));
});

test("without access to the project nothing is read or written", async () => {
  const db = memory();
  const none = deps(null, db);
  const refused = { ok: false, reason: "not_found" };
  assert.deepEqual(await readOverviewLayout("p1", none), refused);
  assert.deepEqual(await changeOverviewLayout("p1", HIDE, none), refused);
  assert.deepEqual(db.calls, []);
});

test("an API key reads the default and cannot write", async () => {
  const db = memory();
  const key = deps({ kind: "api-key" }, db);
  assert.deepEqual(await readOverviewLayout("p1", key), { ok: true, layout: DEFAULT_LAYOUT });
  assert.deepEqual(await changeOverviewLayout("p1", HIDE, key), { ok: false, reason: "api_key" });
  assert.deepEqual(db.calls, []);
});

test("a support session reads the default and cannot write, and the personal layout stays", async () => {
  const db = memory();
  assert.ok((await changeOverviewLayout("p1", HIDE, deps(PERSON, db))).ok);
  const personal = await readOverviewLayout("p1", deps(PERSON, db));
  db.calls.length = 0;
  const support = deps({ ...PERSON, restricted: true }, db);
  assert.deepEqual(await readOverviewLayout("p1", support), { ok: true, layout: DEFAULT_LAYOUT });
  assert.deepEqual(await changeOverviewLayout("p1", HIDE, support), {
    ok: false,
    reason: "support_session",
  });
  assert.deepEqual(db.calls, [], "the store is not read");
  assert.deepEqual(await readOverviewLayout("p1", deps(PERSON, db)), personal);
});

test("a change that is not one writes nothing", async () => {
  const db = memory();
  assert.deepEqual(
    await changeOverviewLayout("p1", { kind: "hide", widget: "x" }, deps(PERSON, db)),
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
