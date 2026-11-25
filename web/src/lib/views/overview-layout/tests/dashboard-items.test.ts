import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changeOverviewLayout,
  type DashboardWidgetSource,
  type LayoutDeps,
  type LayoutReader,
  readOverviewHistory,
  readOverviewLayout,
  restoreOverviewLayout,
  undoOverviewChange,
} from "../actions";
import { KEPT_CHANGES, type LayoutRecord, NO_RECORD } from "../domain/history";
import {
  DEFAULT_LAYOUT,
  dashboardItemId,
  MAX_DASHBOARD_ITEMS,
  type OverviewLayout,
  parseDashboardItem,
  stepChange,
  WIDGET_CATALOG,
} from "../domain/layout";
import type { OverviewLayoutStore } from "../ports/store";

/** A dashboard widget on the Overview: an entry of the layout that names its source. */

const BOARD = "44444444-4444-4444-8444-444444444444";
const COST = dashboardItemId(BOARD, "cost");
const SOURCE: DashboardWidgetSource = { title: "Cost by model", w: 6, h: 5 };
const PERSON: LayoutReader = {
  kind: "person",
  projectId: "p1",
  personId: "user_1",
  restricted: false,
};

function page(change: Partial<LayoutDeps> = {}) {
  let record: LayoutRecord = NO_RECORD;
  const store: OverviewLayoutStore = {
    read: async () => record,
    update: async (_, next) => {
      const entry = next(record);
      if (entry)
        record = {
          layout: JSON.parse(JSON.stringify(entry.layout)),
          entries: [{ ...entry, at: new Date() }, ...record.entries].slice(0, KEPT_CHANGES),
        };
      return record;
    },
  };
  const deps: LayoutDeps = {
    reader: async () => PERSON,
    store: () => store,
    offered: async () => WIDGET_CATALOG,
    dashboardWidget: async (projectId, { dashboardId, widgetId }) =>
      projectId === "p1" && dashboardId === BOARD && !widgetId.startsWith("gone") ? SOURCE : null,
    dashboardsOn: async () => true,
    source: async () => ({ kind: "web" }),
    ...change,
  };
  return {
    deps,
    stored: () => record.layout,
    change: (what: object, at: Partial<LayoutDeps> = {}) =>
      changeOverviewLayout("p1", what, { ...deps, ...at }, null),
    read: async (at: Partial<LayoutDeps> = {}) => {
      const result = await readOverviewLayout("p1", { ...deps, ...at });
      assert.ok(result.ok);
      return result;
    },
    words: async () => {
      const history = await readOverviewHistory("p1", deps);
      assert.ok(history.ok);
      return history.entries.map(({ summary }) => summary);
    },
  };
}

const itemIn = (layout: OverviewLayout, id = COST) => layout.find((entry) => entry.id === id);

test("a reference has the dashboard and the widget, and reads back", () => {
  assert.deepEqual(parseDashboardItem(COST), { dashboardId: BOARD, widgetId: "cost" });
  assert.deepEqual(parseDashboardItem(dashboardItemId(BOARD, "a:b")), {
    dashboardId: BOARD,
    widgetId: "a:b",
  });
  for (const id of ["metrics", "dashboard:", "dashboard:x:y", `dashboard:${BOARD}`])
    assert.equal(parseDashboardItem(id), null, id);
});

test("add puts it at the bottom with the size of its source; move, resize and a step place it", async () => {
  const at = page();
  const added = await at.change({ kind: "add", widget: COST });
  assert.ok(added.ok);
  assert.deepEqual(itemIn(added.layout), {
    id: COST,
    x: 0,
    y: Math.max(...DEFAULT_LAYOUT.map(({ y, h }) => y + h)),
    w: 6,
    h: 5,
    removed: false,
    title: "Cost by model",
  });
  const moved = await at.change({ kind: "move", widget: COST, x: 2, y: 0 });
  assert.ok(moved.ok);
  assert.equal(itemIn(moved.layout)?.y, 0);
  const resized = await at.change({ kind: "resize", widget: COST, w: 1, h: 1 });
  assert.ok(resized.ok);
  const { w, h } = itemIn(resized.layout) ?? {};
  assert.deepEqual([w, h], [2, 2], "the minimum of a dashboard widget");
  const step = stepChange(resized.layout, COST, "wider");
  assert.ok(step);
  const stepped = await at.change(step);
  assert.ok(stepped.ok);
  assert.equal(itemIn(stepped.layout)?.w, 3);
  assert.deepEqual((await at.read()).layout, stepped.layout);
  assert.deepEqual(await at.words(), [
    "Resized Cost by model",
    "Resized Cost by model",
    "Moved Cost by model",
    "Added Cost by model",
  ]);
});

test("remove forgets it; undo and restore bring it back where it was", async () => {
  const at = page();
  await at.change({ kind: "add", widget: COST });
  const before = (await at.change({ kind: "move", widget: COST, x: 6, y: 3 })) as { ok: true };
  assert.ok(before.ok);
  const placed = itemIn((await at.read()).layout);
  const removed = await at.change({ kind: "remove", widget: COST });
  assert.ok(removed.ok);
  assert.equal(itemIn(removed.layout), undefined);
  assert.equal(removed.changed, "Removed Cost by model");
  const undone = await undoOverviewChange("p1", at.deps, removed.revision);
  assert.ok(undone.ok);
  assert.deepEqual(itemIn(undone.layout), placed);
  assert.equal(undone.changed, "Took back: Removed Cost by model");
  await at.change({ kind: "remove", widget: COST });
  const { revision } = await at.read();
  const restored = await restoreOverviewLayout("p1", 2, at.deps, revision);
  assert.ok(restored.ok);
  assert.deepEqual(itemIn(restored.layout), placed);
});

test("reset takes it away, and add of one that is there changes nothing", async () => {
  const at = page();
  await at.change({ kind: "add", widget: COST });
  const again = await at.change({ kind: "add", widget: COST });
  assert.ok(again.ok);
  assert.equal(again.changed, null);
  const reset = await at.change({ kind: "reset" });
  assert.ok(reset.ok);
  assert.deepEqual(reset.layout, DEFAULT_LAYOUT);
});

test("the limit, a source that is not there, and dashboards that are off are refused", async () => {
  const at = page();
  for (let index = 0; index < MAX_DASHBOARD_ITEMS; index += 1)
    assert.ok((await at.change({ kind: "add", widget: dashboardItemId(BOARD, `w${index}`) })).ok);
  const before = at.stored();
  const refused = async (reason: string, widget: string, deps: Partial<LayoutDeps> = {}) =>
    assert.deepEqual(await at.change({ kind: "add", widget }, deps), { ok: false, reason });
  await refused("too_many", COST);
  assert.ok((await at.change({ kind: "add", widget: dashboardItemId(BOARD, "w0") })).ok);
  await refused("no_source", dashboardItemId(BOARD, "gone"));
  await refused("no_source", dashboardItemId(PERSON.kind === "person" ? ORG : "", "cost"));
  await refused("invalid", "dashboard:x");
  await refused("dashboards_off", COST, { dashboardsOn: async () => false });
  await refused("api_key", COST, { reader: async () => ({ kind: "api-key" }) });
  await refused("support_session", COST, { reader: async () => ({ ...PERSON, restricted: true }) });
  await refused("not_found", COST, { reader: async () => null });
  assert.deepEqual(at.stored(), before);
});

test("with dashboards off the entry is kept and not drawn, and it comes back", async () => {
  const at = page();
  await at.change({ kind: "add", widget: COST });
  const placed = itemIn((await at.read()).layout);
  const off = { dashboardsOn: async () => false };
  assert.equal(itemIn((await at.read(off)).layout), undefined);
  assert.ok((await at.change({ kind: "remove", widget: "topology" }, off)).ok);
  assert.ok((await at.change({ kind: "add", widget: "topology" }, off)).ok);
  assert.deepEqual(itemIn((await at.read()).layout), placed);
});

test("a source that is gone, or a reference that cannot be read, can still be moved and removed", async () => {
  const at = page();
  await at.change({ kind: "add", widget: COST });
  const gone = { dashboardWidget: async () => null };
  assert.ok((await at.change({ kind: "move", widget: COST, x: 0, y: 0 }, gone)).ok);
  const removed = await at.change({ kind: "remove", widget: COST }, gone);
  assert.ok(removed.ok && !itemIn(removed.layout));
});

const ORG = "22222222-2222-4222-8222-222222222222";
