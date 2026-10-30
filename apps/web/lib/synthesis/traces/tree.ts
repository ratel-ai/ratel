import type { OtelSpan } from "@/lib/ingest/otlp/schema";

export interface SpanTreeNode {
  span: OtelSpan;
  children: SpanTreeNode[];
  depth: number;
  path: string[];
  orphaned: boolean;
}

export interface BuildSpanTreeOptions {
  maxPathSegments?: number;
}

type ParentByNode = Map<SpanTreeNode, SpanTreeNode | undefined>;

export function buildSpanTree(
  spans: readonly OtelSpan[],
  options: BuildSpanTreeOptions = {},
): SpanTreeNode[] {
  const nodes = [...spans].sort(compareSpans).map(createNode);
  const nodesBySpanId = new Map(nodes.map((node) => [node.span.spanId, node]));
  const parents = resolveParents(nodes, nodesBySpanId);
  const roots: SpanTreeNode[] = [];
  const maxPathSegments = options.maxPathSegments
    ? Math.max(2, Math.floor(options.maxPathSegments))
    : Number.POSITIVE_INFINITY;

  breakParentCycles(nodes, parents);

  for (const node of nodes) {
    const parent = parents.get(node);

    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  for (const root of roots) {
    addNavigationMetadata(root, 0, [], maxPathSegments);
  }

  return roots;
}

function resolveParents(
  nodes: SpanTreeNode[],
  nodesBySpanId: Map<string, SpanTreeNode>,
): ParentByNode {
  const parents: ParentByNode = new Map();

  for (const node of nodes) {
    const parentSpanId = node.span.parentSpanId;
    const parent = parentSpanId === null ? undefined : nodesBySpanId.get(parentSpanId);

    if (parentSpanId !== null && !parent) {
      node.orphaned = true;
    }
    parents.set(node, parent);
  }

  return parents;
}

function breakParentCycles(nodes: SpanTreeNode[], parents: ParentByNode): void {
  const resolved = new Set<SpanTreeNode>();

  for (const node of nodes) {
    if (resolved.has(node)) continue;

    const path: SpanTreeNode[] = [];
    const positions = new Map<SpanTreeNode, number>();
    let current: SpanTreeNode | undefined = node;

    while (current && !resolved.has(current)) {
      const cycleStart = positions.get(current);
      if (cycleStart !== undefined) {
        const breaker = path
          .slice(cycleStart)
          .reduce((first, candidate) =>
            compareSpans(candidate.span, first.span) < 0 ? candidate : first,
          );
        parents.set(breaker, undefined);
        breaker.orphaned = true;
        break;
      }

      positions.set(current, path.length);
      path.push(current);
      current = parents.get(current);
    }

    for (const visited of path) {
      resolved.add(visited);
    }
  }
}

function compareSpans(left: OtelSpan, right: OtelSpan): number {
  const timeDifference = left.startedAt.getTime() - right.startedAt.getTime();
  if (timeDifference !== 0) return timeDifference;
  if (left.spanId < right.spanId) return -1;
  if (left.spanId > right.spanId) return 1;
  return 0;
}

function createNode(span: OtelSpan): SpanTreeNode {
  return {
    span,
    children: [],
    depth: 0,
    path: [],
    orphaned: false,
  };
}

function addNavigationMetadata(
  node: SpanTreeNode,
  depth: number,
  parentPath: string[],
  maxPathSegments: number,
): void {
  node.depth = depth;
  node.path = appendPath(parentPath, node.span.name, maxPathSegments);
  const pending = [node];

  while (pending.length > 0) {
    const current = pending.pop()!;

    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      const child = current.children[index];
      child.depth = current.depth + 1;
      child.path = appendPath(current.path, child.span.name, maxPathSegments);
      pending.push(child);
    }
  }
}

/**
 * Append a span name to a bounded breadcrumb path, replacing the oldest
 * segments with a single ellipsis once the budget is reached. Shared with the
 * waterfall's client-side path derivation so both stay in lockstep.
 */
export function appendPath(
  parentPath: readonly string[],
  name: string,
  maxPathSegments: number,
): string[] {
  if (parentPath.length < maxPathSegments) {
    return [...parentPath, name];
  }
  // slice(-(2 - 2)) would be slice(0) — the whole path — so the minimum
  // budget keeps only the ellipsis and the span's own name.
  if (maxPathSegments <= 2) {
    return ["…", name];
  }
  return ["…", ...parentPath.slice(-(maxPathSegments - 2)), name];
}
