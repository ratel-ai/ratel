import type { OtelSpan } from "@/lib/ingest/otlp/schema";
import { buildSpanTree, type SpanTreeNode } from "./tree";

export interface ComparedSpan {
  /** Root-to-span names. */
  readonly path: readonly string[];
  /** Zero-based occurrence among the current span's same-name siblings. */
  readonly occurrence: number;
  readonly left: OtelSpan | null;
  readonly right: OtelSpan | null;
}

interface IndexedSpan {
  readonly path: readonly string[];
  readonly structuralPath: readonly PathSegment[];
  readonly span: OtelSpan;
}

interface PathSegment {
  readonly name: string;
  readonly occurrence: number;
}

interface IndexFrame {
  readonly nodes: readonly SpanTreeNode[];
  readonly parentPath: readonly PathSegment[];
  readonly occurrences: Map<string, number>;
  nextIndex: number;
}

/**
 * Aligns spans by ancestor-name path and zero-based sibling occurrence.
 * Rows use a side-neutral, deterministic structural-path order.
 */
export function compareTraces(
  leftSpans: readonly OtelSpan[],
  rightSpans: readonly OtelSpan[],
): ComparedSpan[] {
  const leftByPath = indexByPath(leftSpans);
  const rightByPath = indexByPath(rightSpans);
  const rows = [...new Set([...leftByPath.keys(), ...rightByPath.keys()])].map((key) => {
    const indexed = (leftByPath.get(key) ?? rightByPath.get(key))!;
    return {
      structuralPath: indexed.structuralPath,
      comparison: {
        path: indexed.path,
        occurrence: indexed.structuralPath.at(-1)!.occurrence,
        left: leftByPath.get(key)?.span ?? null,
        right: rightByPath.get(key)?.span ?? null,
      },
    };
  });

  return rows
    .sort((left, right) => compareStructuralPaths(left.structuralPath, right.structuralPath))
    .map(({ comparison }) => comparison);
}

function indexByPath(spans: readonly OtelSpan[]): Map<string, IndexedSpan> {
  const indexed = new Map<string, IndexedSpan>();
  indexNodes(buildSpanTree(spans), [], indexed);
  return indexed;
}

function indexNodes(
  nodes: readonly SpanTreeNode[],
  parentPath: readonly PathSegment[],
  indexed: Map<string, IndexedSpan>,
): void {
  const pending: IndexFrame[] = [
    {
      nodes,
      parentPath,
      occurrences: new Map(),
      nextIndex: 0,
    },
  ];

  while (pending.length > 0) {
    const frame = pending.at(-1)!;
    if (frame.nextIndex >= frame.nodes.length) {
      pending.pop();
      continue;
    }

    const node = frame.nodes[frame.nextIndex];
    frame.nextIndex += 1;
    const occurrence = frame.occurrences.get(node.span.name) ?? 0;
    const structuralPath = [...frame.parentPath, { name: node.span.name, occurrence }];
    indexed.set(structuralKey(structuralPath), {
      path: node.path,
      structuralPath,
      span: node.span,
    });
    frame.occurrences.set(node.span.name, occurrence + 1);

    if (node.children.length > 0) {
      pending.push({
        nodes: node.children,
        parentPath: structuralPath,
        occurrences: new Map(),
        nextIndex: 0,
      });
    }
  }
}

function structuralKey(path: readonly PathSegment[]): string {
  return JSON.stringify(path.map(({ name, occurrence }) => [name, occurrence]));
}

function compareStructuralPaths(
  left: readonly PathSegment[],
  right: readonly PathSegment[],
): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const names = compareStrings(left[index].name, right[index].name);
    if (names !== 0) return names;
    const occurrences = left[index].occurrence - right[index].occurrence;
    if (occurrences !== 0) return occurrences;
  }
  return left.length - right.length;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
