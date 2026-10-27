/**
 * Pure table logic, kept out of the client component so server code and tests
 * can call it (a function exported from a "use client" module is a client
 * reference on the server).
 */

export type SortDirection = "asc" | "desc";
export type TableSort = { id: string; direction: SortDirection };

/** The direction a header link should request next. */
export function nextSortDirection(
  columnId: string,
  current: TableSort | undefined,
  defaultDirection: SortDirection,
): SortDirection {
  if (current?.id !== columnId) return defaultDirection;
  return current.direction === "asc" ? "desc" : "asc";
}

export type RowKeyAction = "next" | "previous" | "open" | "toggle";

/**
 * What a key does on a table row (DESIGN.md, Keyboard first): `j`, `k` and
 * the arrows move, Enter opens, Space or `x` toggles the row's selection, so
 * its checkbox needs no tab stop of its own. Enter, Space and `x` act on the
 * focused row itself, never on a control inside it.
 */
export function rowKeyAction(
  key: string,
  { onRow, canOpen, canToggle }: { onRow: boolean; canOpen: boolean; canToggle: boolean },
): RowKeyAction | null {
  if (key === "j" || key === "ArrowDown") return "next";
  if (key === "k" || key === "ArrowUp") return "previous";
  if (!onRow) return null;
  if (key === "Enter" && canOpen) return "open";
  if ((key === " " || key === "x") && canToggle) return "toggle";
  return null;
}

/**
 * The row that holds the table's one tab stop. Clamped to the rows that exist,
 * so a filter that shrinks the list never leaves the table with no tab stop.
 */
export function rovingIndex(focusIndex: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(Math.max(0, focusIndex), count - 1);
}
