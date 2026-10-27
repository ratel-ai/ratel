"use client";

import { ChevronRight } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../cn";
import {
  type TreeModelNode,
  type TreeRow,
  treeKeyAction,
  treeTabStop,
  treeTypeahead,
  visibleTreeRows,
  withExpanded,
} from "./tree-model";

export type { TreeModelNode, TreeRow } from "./tree-model";

export type TreeNode = TreeModelNode & {
  children?: readonly TreeNode[];
  /** Rendered in place of the label (a mono name). The label still names the row and drives typeahead. */
  content?: ReactNode;
  /** Quiet trailing text, usually a count. Visual only: say what it means in `metaLabel`. */
  meta?: ReactNode;
  /** What `meta` means for assistive tech ("12 calls"), read after the label. */
  metaLabel?: string;
};

export type TreeProps = {
  /** Accessible name of the tree. */
  label: string;
  nodes: readonly TreeNode[];
  expanded: ReadonlySet<string>;
  onExpandedChange: (next: Set<string>) => void;
  selectedId?: string | null;
  /** Called for a leaf on click, Enter or Space. A parent toggles instead. */
  onSelect?: (id: string) => void;
  className?: string;
};

/** How long typed letters keep adding to one typeahead word. */
const TYPEAHEAD_MS = 600;

/**
 * A hierarchy to browse and pick from (WAI-ARIA tree view). Rows render flat
 * with their level, size and position, so the keyboard model is one array:
 * up and down move, right and left open, close and step in and out, Home and
 * End jump, Enter selects, and typing jumps to a row by name. One row holds the
 * tab stop (roving tabindex); selection is single and does not follow focus.
 *
 * Letters are typeahead here, `j` and `k` included, unlike in a DataTable:
 * rows are found by name in a tree, and plenty of names start with those two.
 */
export function Tree({
  label,
  nodes,
  expanded,
  onExpandedChange,
  selectedId = null,
  onSelect,
  className,
}: TreeProps) {
  const rows = useMemo(() => visibleTreeRows(nodes, expanded), [nodes, expanded]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const typed = useRef({ text: "", at: Number.NEGATIVE_INFINITY });
  const tabStop = treeTabStop(rows, focusedId, selectedId);

  // A deep-linked selection scrolls into view once, inside the tree's own scroller.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on arrival; later selections come from the reader's own clicks and keys.
  useEffect(() => {
    if (selectedId) rowRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
  }, []);

  function focusRow(id: string) {
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  }

  function activate(row: TreeRow<TreeNode>) {
    if (row.expandable) onExpandedChange(withExpanded(expanded, row.node.id, !row.expanded));
    else onSelect?.(row.node.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, row: TreeRow<TreeNode>) {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey)
      return;
    const action = treeKeyAction(rows, row.node.id, event.key);
    if (action) {
      event.preventDefault();
      if (action.type === "focus") focusRow(action.id);
      else if (action.type === "expand") onExpandedChange(withExpanded(expanded, action.id, true));
      else if (action.type === "collapse")
        onExpandedChange(withExpanded(expanded, action.id, false));
      else activate(row);
      return;
    }
    if (event.key.length === 1 && event.key.trim() !== "") {
      const at = event.timeStamp;
      const text =
        at - typed.current.at < TYPEAHEAD_MS ? typed.current.text + event.key : event.key;
      typed.current = { text, at };
      const match = treeTypeahead(rows, row.node.id, text);
      if (match) {
        event.preventDefault();
        focusRow(match);
      }
    }
  }

  return (
    <div role="tree" aria-label={label} className={cn("flex flex-col gap-px", className)}>
      {rows.map((row) => {
        const { node } = row;
        const selected = !row.expandable && node.id === selectedId;
        return (
          <div
            key={node.id}
            ref={(element) => {
              if (element) rowRefs.current.set(node.id, element);
              else rowRefs.current.delete(node.id);
            }}
            role="treeitem"
            data-tree-id={node.id}
            aria-level={row.level}
            aria-setsize={row.setSize}
            aria-posinset={row.posInSet}
            aria-expanded={row.expandable ? row.expanded : undefined}
            // Single select: only the chosen leaf carries the state (APG, tree view).
            aria-selected={selected ? true : undefined}
            tabIndex={node.id === tabStop ? 0 : -1}
            onFocus={(event) => {
              if (event.target === event.currentTarget) setFocusedId(node.id);
            }}
            onKeyDown={(event) => onKeyDown(event, row)}
            onClick={() => {
              setFocusedId(node.id);
              activate(row);
            }}
            style={{ paddingLeft: `${(row.level - 1) * 16 + 4}px` }}
            className={cn(
              "flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md pr-2 text-ui outline-none select-none",
              "transition-colors duration-120 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
              selected
                ? "bg-selected text-fg shadow-[inset_2px_0_0_var(--ds-accent-mark)]"
                : "text-fg-muted hover:bg-hover hover:text-fg",
            )}
          >
            {row.expandable ? (
              <ChevronRight
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 text-fg-subtle transition-transform duration-160 ease-enter motion-reduce:transition-none",
                  row.expanded && "rotate-90",
                )}
              />
            ) : (
              <span aria-hidden className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{node.content ?? node.label}</span>
            {node.meta !== undefined ? (
              <span aria-hidden className="shrink-0 pl-2 text-xs text-fg-subtle tabular-nums">
                {node.meta}
              </span>
            ) : null}
            {node.metaLabel ? <span className="sr-only">, {node.metaLabel}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
