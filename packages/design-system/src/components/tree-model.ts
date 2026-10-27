/**
 * Pure logic behind the ds `Tree` (the WAI-ARIA tree view pattern), kept out of
 * the client component so server code and tests can call it, the same split as
 * `table-model.ts`. The component renders the visible rows flat, each carrying
 * its level, set size and position, so the keyboard model below only ever
 * walks one array.
 */

export interface TreeModelNode {
  id: string;
  /** The row's name: what typeahead matches and what the row is called. */
  label: string;
  /** Present, even when empty, on a node that can open. */
  children?: readonly TreeModelNode[];
}

export interface TreeRow<T extends TreeModelNode = TreeModelNode> {
  node: T;
  /** 1 for a root. */
  level: number;
  setSize: number;
  /** 1-based position among its siblings. */
  posInSet: number;
  parentId: string | null;
  expandable: boolean;
  expanded: boolean;
}

/** The rows a reader can see: every root, and the children of each open node, depth first. */
export function visibleTreeRows<T extends TreeModelNode>(
  nodes: readonly T[],
  expanded: ReadonlySet<string>,
): TreeRow<T>[] {
  const rows: TreeRow<T>[] = [];
  const walk = (siblings: readonly T[], level: number, parentId: string | null) => {
    siblings.forEach((node, index) => {
      const expandable = node.children !== undefined;
      const open = expandable && expanded.has(node.id);
      rows.push({
        node,
        level,
        setSize: siblings.length,
        posInSet: index + 1,
        parentId,
        expandable,
        expanded: open,
      });
      if (open) walk(node.children as readonly T[], level + 1, node.id);
    });
  };
  walk(nodes, 1, null);
  return rows;
}

/** The ids from the root down to `id`'s parent, so a deep link can open its path; null when absent. */
export function treePath(nodes: readonly TreeModelNode[], id: string): string[] | null {
  for (const node of nodes) {
    if (node.id === id) return [];
    if (node.children) {
      const below = treePath(node.children, id);
      if (below) return [node.id, ...below];
    }
  }
  return null;
}

/** Every node that can open, for a filtered tree that shows all of its matches. */
export function expandableIds(nodes: readonly TreeModelNode[]): string[] {
  const ids: string[] = [];
  const walk = (siblings: readonly TreeModelNode[]) => {
    for (const node of siblings) {
      if (!node.children) continue;
      ids.push(node.id);
      walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}

export type TreeKeyAction =
  | { type: "focus"; id: string }
  | { type: "expand"; id: string }
  | { type: "collapse"; id: string }
  | { type: "toggle"; id: string }
  | { type: "select"; id: string };

/**
 * What a key does on the focused row (WAI-ARIA APG, tree view): up and down
 * move, right opens a closed node or steps into an open one, left closes an
 * open node or steps out to the parent, Home and End jump, Enter and Space
 * select a leaf or toggle a parent. Null for keys the tree does not own.
 */
export function treeKeyAction(
  rows: readonly TreeRow[],
  focusedId: string,
  key: string,
): TreeKeyAction | null {
  if (rows.length === 0) return null;
  const index = rows.findIndex((row) => row.node.id === focusedId);
  if (index < 0) return { type: "focus", id: rows[0].node.id };
  const row = rows[index];
  const id = row.node.id;
  switch (key) {
    case "ArrowDown":
      return index < rows.length - 1 ? { type: "focus", id: rows[index + 1].node.id } : null;
    case "ArrowUp":
      return index > 0 ? { type: "focus", id: rows[index - 1].node.id } : null;
    case "ArrowRight": {
      if (!row.expandable) return null;
      if (!row.expanded) return { type: "expand", id };
      const firstChild = rows[index + 1];
      return firstChild && firstChild.parentId === id
        ? { type: "focus", id: firstChild.node.id }
        : null;
    }
    case "ArrowLeft":
      if (row.expandable && row.expanded) return { type: "collapse", id };
      return row.parentId ? { type: "focus", id: row.parentId } : null;
    case "Home":
      return { type: "focus", id: rows[0].node.id };
    case "End":
      return { type: "focus", id: rows[rows.length - 1].node.id };
    case "Enter":
    case " ":
      return row.expandable ? { type: "toggle", id } : { type: "select", id };
    default:
      return null;
  }
}

/**
 * Typeahead: the next row whose label starts with what was typed, wrapping
 * around. One character (or the same one repeated) cycles past the focused
 * row; a longer word keeps the focused row when it still matches.
 */
export function treeTypeahead(
  rows: readonly TreeRow[],
  focusedId: string | null,
  typed: string,
): string | null {
  if (rows.length === 0 || typed === "") return null;
  const lowered = typed.toLowerCase();
  const repeated = [...lowered].every((character) => character === lowered[0]);
  const needle = repeated ? lowered[0] : lowered;
  const current = rows.findIndex((row) => row.node.id === focusedId);
  const start = current < 0 ? 0 : repeated ? current + 1 : current;
  for (let offset = 0; offset < rows.length; offset += 1) {
    const row = rows[(start + offset) % rows.length];
    if (row.node.label.toLowerCase().startsWith(needle)) return row.node.id;
  }
  return null;
}

/**
 * The row that holds the tree's one tab stop: the focused row while it is
 * visible, else the selected one, else the first. A collapse or a filter that
 * hides the focused row never leaves the tree without a way in.
 */
export function treeTabStop(
  rows: readonly TreeRow[],
  focusedId: string | null,
  selectedId: string | null,
): string | null {
  if (focusedId && rows.some((row) => row.node.id === focusedId)) return focusedId;
  if (selectedId && rows.some((row) => row.node.id === selectedId)) return selectedId;
  return rows[0]?.node.id ?? null;
}

/** A copy of the open set with one node opened or closed. */
export function withExpanded(
  expanded: ReadonlySet<string>,
  id: string,
  open: boolean,
): Set<string> {
  const next = new Set(expanded);
  if (open) next.add(id);
  else next.delete(id);
  return next;
}
