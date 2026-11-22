import assert from "node:assert/strict";
import { test } from "node:test";
import { consoleCommandActions } from "./command-actions";

function build(edition?: Parameters<typeof consoleCommandActions>[0]["edition"]) {
  const dispatched: string[] = [];
  const calls: string[] = [];
  const actions = consoleCommandActions({
    edition,
    collapsed: false,
    openShortcuts: () => calls.push("shortcuts"),
    toggleCollapsed: () => calls.push("sidebar"),
    dispatch: (event) => dispatched.push(event),
  });
  return { actions, dispatched, calls };
}

test("without an edition the palette keeps its two actions", () => {
  for (const edition of [undefined, []]) {
    const { actions } = build(edition);
    assert.deepEqual(
      actions.map(({ id, label, group, keywords }) => ({ id, label, group, keywords })),
      [
        {
          id: "shortcuts",
          label: "Keyboard shortcuts",
          group: "Actions",
          keywords: ["keys", "hotkeys", "help"],
        },
        { id: "sidebar", label: "Collapse sidebar", group: "Actions", keywords: ["rail", "menu"] },
      ],
    );
  }
});

test("the sidebar action names the way it toggles", () => {
  const actions = consoleCommandActions({
    collapsed: true,
    openShortcuts: () => {},
    toggleCollapsed: () => {},
  });
  assert.equal(actions.find(({ id }) => id === "sidebar")?.label, "Expand sidebar");
});

test("the edition's actions come first, in its order, as upstream lists Send feedback", () => {
  const { actions } = build([
    { id: "feedback", label: "Send feedback", keywords: ["bug", "idea", "report"], event: "x:a" },
    { id: "other", label: "Other", event: "x:b" },
  ]);
  assert.deepEqual(
    actions.map(({ id }) => id),
    ["feedback", "other", "shortcuts", "sidebar"],
  );
  assert.deepEqual(actions[0]?.keywords, ["bug", "idea", "report"]);
  assert.equal(actions[0]?.group, "Actions");
});

test("running an edition action dispatches its window event, and nothing else", () => {
  const { actions, dispatched, calls } = build([
    { id: "feedback", label: "Send feedback", event: "ratel:open-feedback" },
  ]);
  actions[0]?.run();
  assert.deepEqual(dispatched, ["ratel:open-feedback"]);
  assert.deepEqual(calls, []);
  actions[1]?.run();
  actions[2]?.run();
  assert.deepEqual(calls, ["shortcuts", "sidebar"]);
  assert.deepEqual(dispatched, ["ratel:open-feedback"]);
});

test("an edition action cannot shadow the console's own ids", () => {
  const { actions } = build([{ id: "shortcuts", label: "Mine", event: "x:y" }]);
  assert.deepEqual(
    actions.map(({ id }) => id),
    ["shortcuts", "sidebar"],
  );
  assert.equal(actions[0]?.label, "Keyboard shortcuts");
});
