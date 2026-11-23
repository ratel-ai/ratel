"use client";

import { Tree, type TreeNode } from "@ratel/design-system/tree";
import { useMemo } from "react";
import { fmtCompact, fmtExact, plural } from "@/lib/console/catalog/format";
import { type CatalogTreeNode, SKILLS_ROOT } from "@/lib/console/catalog/tree";

/** The catalog tree's nodes as ds Tree rows: mono names, quiet counts, and what each count means. */
export function catalogTreeNodes(
  nodes: readonly CatalogTreeNode[],
  kind: "tool" | "skill" = "tool",
): TreeNode[] {
  return nodes.map((node) => {
    const nodeKind = node.kind === "root" ? (node.id === SKILLS_ROOT ? "skill" : "tool") : kind;
    if (node.kind === "item") {
      // Usage is the quiet number on a leaf; nothing at all reads better than a column of zeros.
      return {
        id: node.id,
        label: node.label,
        content: <span className="font-mono text-xs">{node.label}</span>,
        meta: node.count > 0 ? fmtCompact(node.count) : undefined,
        metaLabel:
          node.count > 0 ? plural(node.count, nodeKind === "tool" ? "call" : "run") : undefined,
      };
    }
    return {
      id: node.id,
      label: node.label,
      content:
        node.kind === "root" ? (
          <span className="font-medium text-fg">{node.label}</span>
        ) : undefined,
      meta: fmtExact(node.count),
      metaLabel: plural(node.count, nodeKind),
      children: catalogTreeNodes(node.children ?? [], nodeKind),
    };
  });
}

export function CatalogTree({
  nodes,
  expanded,
  onExpandedChange,
  selectedKey,
  onSelect,
}: {
  nodes: readonly CatalogTreeNode[];
  expanded: ReadonlySet<string>;
  onExpandedChange: (next: Set<string>) => void;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const treeNodes = useMemo(() => catalogTreeNodes(nodes), [nodes]);
  return (
    <Tree
      label="Catalog items"
      nodes={treeNodes}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      selectedId={selectedKey}
      onSelect={onSelect}
    />
  );
}
