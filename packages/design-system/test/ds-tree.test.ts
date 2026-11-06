import assert from "node:assert/strict";
import { test } from "node:test";
import {
  expandableIds,
  type TreeModelNode,
  treeKeyAction,
  treePath,
  treeTabStop,
  treeTypeahead,
  visibleTreeRows,
  withExpanded,
} from "../src/components/tree-model";

const NODES: readonly TreeModelNode[] = [
  {
    id: "tools",
    label: "Tools",
    children: [
      {
        id: "kanban",
        label: "kanban",
        children: [
          { id: "k1", label: "kanban_create_task" },
          { id: "k2", label: "kanban_update_task" },
        ],
      },
      { id: "ripgrep", label: "ripgrep" },
    ],
  },
  { id: "skills", label: "Skills", children: [{ id: "s1", label: "review-pull-request" }] },
];

const ids = (expanded: string[]) =>
  visibleTreeRows(NODES, new Set(expanded)).map((row) => row.node.id);

test("only the roots and the children of open nodes are visible, depth first", () => {
  assert.deepEqual(ids([]), ["tools", "skills"]);
  assert.deepEqual(ids(["tools"]), ["tools", "kanban", "ripgrep", "skills"]);
  assert.deepEqual(ids(["tools", "kanban", "skills"]), [
    "tools",
    "kanban",
    "k1",
    "k2",
    "ripgrep",
    "skills",
    "s1",
  ]);
  assert.deepEqual(
    ids(["kanban"]),
    ["tools", "skills"],
    "a child stays hidden while its parent is closed",
  );
});

test("each row knows its level, its place among its siblings and its parent", () => {
  const rows = visibleTreeRows(NODES, new Set(["tools", "kanban"]));
  const k2 = rows.find((row) => row.node.id === "k2");
  assert.deepEqual(
    k2 && {
      level: k2.level,
      setSize: k2.setSize,
      posInSet: k2.posInSet,
      parentId: k2.parentId,
      expandable: k2.expandable,
    },
    { level: 3, setSize: 2, posInSet: 2, parentId: "kanban", expandable: false },
  );
  const tools = rows[0];
  assert.equal(tools.expanded, true);
  assert.equal(rows.find((row) => row.node.id === "skills")?.expanded, false);
});

test("up and down walk the visible rows and stop at both ends", () => {
  const rows = visibleTreeRows(NODES, new Set(["tools", "kanban"]));
  assert.deepEqual(treeKeyAction(rows, "kanban", "ArrowDown"), { type: "focus", id: "k1" });
  assert.deepEqual(treeKeyAction(rows, "ripgrep", "ArrowUp"), { type: "focus", id: "k2" });
  assert.equal(treeKeyAction(rows, "tools", "ArrowUp"), null);
  assert.equal(treeKeyAction(rows, "skills", "ArrowDown"), null);
});

test("right opens a closed node, then steps to its first child; on a leaf it does nothing", () => {
  const closed = visibleTreeRows(NODES, new Set(["tools"]));
  assert.deepEqual(treeKeyAction(closed, "kanban", "ArrowRight"), {
    type: "expand",
    id: "kanban",
  });
  const open = visibleTreeRows(NODES, new Set(["tools", "kanban"]));
  assert.deepEqual(treeKeyAction(open, "kanban", "ArrowRight"), { type: "focus", id: "k1" });
  assert.equal(treeKeyAction(open, "k1", "ArrowRight"), null);
});

test("left closes an open node, otherwise steps out to the parent", () => {
  const rows = visibleTreeRows(NODES, new Set(["tools", "kanban"]));
  assert.deepEqual(treeKeyAction(rows, "kanban", "ArrowLeft"), {
    type: "collapse",
    id: "kanban",
  });
  assert.deepEqual(treeKeyAction(rows, "k2", "ArrowLeft"), { type: "focus", id: "kanban" });
  assert.deepEqual(treeKeyAction(rows, "ripgrep", "ArrowLeft"), { type: "focus", id: "tools" });
  assert.equal(treeKeyAction(rows, "skills", "ArrowLeft"), null, "a closed root has nowhere to go");
});

test("Home and End jump; Enter and Space select a leaf and toggle a parent", () => {
  const rows = visibleTreeRows(NODES, new Set(["tools", "kanban"]));
  assert.deepEqual(treeKeyAction(rows, "k2", "Home"), { type: "focus", id: "tools" });
  assert.deepEqual(treeKeyAction(rows, "k2", "End"), { type: "focus", id: "skills" });
  assert.deepEqual(treeKeyAction(rows, "k2", "Enter"), { type: "select", id: "k2" });
  assert.deepEqual(treeKeyAction(rows, "kanban", "Enter"), { type: "toggle", id: "kanban" });
  assert.deepEqual(treeKeyAction(rows, "ripgrep", " "), { type: "select", id: "ripgrep" });
  assert.equal(treeKeyAction(rows, "k2", "x"), null, "letters belong to typeahead");
  assert.equal(treeKeyAction([], "k2", "ArrowDown"), null);
  assert.deepEqual(
    treeKeyAction(rows, "gone", "ArrowDown"),
    { type: "focus", id: "tools" },
    "a lost focus restarts at the top",
  );
});

test("typeahead finds the next row by its first letters and wraps around", () => {
  const rows = visibleTreeRows(NODES, new Set(["tools", "kanban", "skills"]));
  assert.equal(treeTypeahead(rows, "tools", "k"), "kanban");
  assert.equal(treeTypeahead(rows, "kanban", "k"), "k1", "the same letter again moves on");
  assert.equal(treeTypeahead(rows, "k1", "kk"), "k2", "a repeated letter cycles");
  assert.equal(treeTypeahead(rows, "kanban", "kanban_u"), "k2");
  assert.equal(
    treeTypeahead(rows, "kanban", "kan"),
    "kanban",
    "a longer word keeps a row that still matches",
  );
  assert.equal(treeTypeahead(rows, "s1", "t"), "tools", "wraps past the end");
  assert.equal(treeTypeahead(rows, "tools", "zzz"), null);
  assert.equal(treeTypeahead(rows, "tools", ""), null);
});

test("the one tab stop follows focus, falls back to the selection, then to the first row", () => {
  const rows = visibleTreeRows(NODES, new Set(["tools"]));
  assert.equal(treeTabStop(rows, "ripgrep", "skills"), "ripgrep");
  assert.equal(
    treeTabStop(rows, "k1", "skills"),
    "skills",
    "a focused row hidden by a collapse gives the stop back",
  );
  assert.equal(
    treeTabStop(rows, null, "k1"),
    "tools",
    "a hidden selection falls back to the first row",
  );
  assert.equal(treeTabStop([], null, null), null);
});

test("paths, open sets and expandable ids", () => {
  assert.deepEqual(treePath(NODES, "k2"), ["tools", "kanban"]);
  assert.deepEqual(treePath(NODES, "tools"), []);
  assert.equal(treePath(NODES, "nope"), null);
  assert.deepEqual(expandableIds(NODES), ["tools", "kanban", "skills"]);
  const open = new Set(["tools"]);
  assert.deepEqual([...withExpanded(open, "kanban", true)], ["tools", "kanban"]);
  assert.deepEqual([...withExpanded(open, "tools", false)], []);
  assert.deepEqual([...open], ["tools"], "the original set is left alone");
});
