import assert from "node:assert/strict";
import { test } from "node:test";
import type { OtelSpan } from "@/lib/ingest/otlp/schema";
import { buildSpanTree, type SpanTreeNode } from "./tree";

type TreeShape = {
  name: string;
  depth: number;
  path: string[];
  orphaned: boolean;
  children: TreeShape[];
};

test("builds a span hierarchy with navigation metadata", () => {
  const root = span({ spanId: "root", name: "request" });
  const child = span({
    spanId: "child",
    parentSpanId: "root",
    name: "agent",
  });
  const grandchild = span({
    spanId: "grandchild",
    parentSpanId: "child",
    name: "tool",
  });

  const tree = buildSpanTree([grandchild, root, child]);

  assert.deepEqual(tree.map(treeShape), [
    {
      name: "request",
      depth: 0,
      path: ["request"],
      orphaned: false,
      children: [
        {
          name: "agent",
          depth: 1,
          path: ["request", "agent"],
          orphaned: false,
          children: [
            {
              name: "tool",
              depth: 2,
              path: ["request", "agent", "tool"],
              orphaned: false,
              children: [],
            },
          ],
        },
      ],
    },
  ]);
  assert.equal(tree[0].span, root);
  assert.equal(tree[0].children[0].span, child);
  assert.equal(tree[0].children[0].children[0].span, grandchild);
});

test("orders roots and children by start time, then span id", () => {
  const spans = [
    span({
      spanId: "root-later",
      name: "root later",
      startedAt: at(20),
    }),
    span({
      spanId: "child-b",
      parentSpanId: "root-first",
      name: "child b",
      startedAt: at(10),
    }),
    span({
      spanId: "child-later",
      parentSpanId: "root-first",
      name: "child later",
      startedAt: at(30),
    }),
    span({
      spanId: "child-a",
      parentSpanId: "root-first",
      name: "child a",
      startedAt: at(10),
    }),
    span({
      spanId: "root-first",
      name: "root first",
      startedAt: at(10),
    }),
  ];

  const tree = buildSpanTree(spans);

  assert.deepEqual(
    tree.map((root) => ({
      spanId: root.span.spanId,
      children: root.children.map((child) => child.span.spanId),
    })),
    [
      {
        spanId: "root-first",
        children: ["child-a", "child-b", "child-later"],
      },
      { spanId: "root-later", children: [] },
    ],
  );
});

test("promotes a subtree whose parent was pruned", () => {
  const promotedRoot = span({
    spanId: "promoted",
    parentSpanId: "missing-parent",
    name: "retained branch",
  });
  const retainedChild = span({
    spanId: "retained-child",
    parentSpanId: "promoted",
    name: "retained leaf",
  });

  const tree = buildSpanTree([retainedChild, promotedRoot]);

  assert.deepEqual(tree.map(treeShape), [
    {
      name: "retained branch",
      depth: 0,
      path: ["retained branch"],
      orphaned: true,
      children: [
        {
          name: "retained leaf",
          depth: 1,
          path: ["retained branch", "retained leaf"],
          orphaned: false,
          children: [],
        },
      ],
    },
  ]);
});

test("breaks a self-parent cycle without dropping its subtree", () => {
  const cyclicRoot = span({
    spanId: "cycle",
    parentSpanId: "cycle",
    name: "cyclic span",
  });
  const child = span({
    spanId: "child",
    parentSpanId: "cycle",
    name: "child",
  });

  const tree = buildSpanTree([child, cyclicRoot]);

  assert.deepEqual(tree.map(treeShape), [
    {
      name: "cyclic span",
      depth: 0,
      path: ["cyclic span"],
      orphaned: true,
      children: [
        {
          name: "child",
          depth: 1,
          path: ["cyclic span", "child"],
          orphaned: false,
          children: [],
        },
      ],
    },
  ]);
});

test("breaks a multi-span cycle at its earliest span deterministically", () => {
  const earliest = span({
    spanId: "b",
    parentSpanId: "a",
    name: "earliest",
    startedAt: at(10),
  });
  const tiedLaterId = span({
    spanId: "c",
    parentSpanId: "b",
    name: "tied later id",
    startedAt: at(10),
  });
  const later = span({
    spanId: "a",
    parentSpanId: "c",
    name: "later",
    startedAt: at(20),
  });
  const leaf = span({
    spanId: "leaf",
    parentSpanId: "a",
    name: "leaf",
    startedAt: at(30),
  });
  const expected: TreeShape[] = [
    {
      name: "earliest",
      depth: 0,
      path: ["earliest"],
      orphaned: true,
      children: [
        {
          name: "tied later id",
          depth: 1,
          path: ["earliest", "tied later id"],
          orphaned: false,
          children: [
            {
              name: "later",
              depth: 2,
              path: ["earliest", "tied later id", "later"],
              orphaned: false,
              children: [
                {
                  name: "leaf",
                  depth: 3,
                  path: ["earliest", "tied later id", "later", "leaf"],
                  orphaned: false,
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  assert.deepEqual(buildSpanTree([later, earliest, leaf, tiedLaterId]).map(treeShape), expected);
  assert.deepEqual(buildSpanTree([tiedLaterId, leaf, earliest, later]).map(treeShape), expected);
});

test("does not mutate the input array or span records", () => {
  const child = Object.freeze(span({ spanId: "child", parentSpanId: "root", name: "child" }));
  const root = Object.freeze(span({ spanId: "root", name: "root" }));
  const input = Object.freeze([child, root]);

  const tree = buildSpanTree(input);

  assert.deepEqual(
    input.map((item) => item.spanId),
    ["child", "root"],
  );
  assert.equal(tree[0].span, root);
  assert.equal(tree[0].children[0].span, child);
});

test("handles a 5000-span-deep trace without overflowing the call stack", () => {
  const tree = buildSpanTree(deepSpanChain(5_000));
  let deepest = tree[0];
  let spanCount = 1;

  while (deepest.children[0]) {
    deepest = deepest.children[0];
    spanCount += 1;
  }

  assert.equal(tree.length, 1);
  assert.equal(spanCount, 5_000);
  assert.equal(deepest.depth, 4_999);
  assert.equal(deepest.path.length, 5_000);
});

test("bounds breadcrumb paths at every supported maxPathSegments value", () => {
  for (const maxPathSegments of [2, 3, 4]) {
    const tree = buildSpanTree(deepSpanChain(6), { maxPathSegments });
    let deepest = tree[0];
    const lengths: number[] = [deepest.path.length];

    while (deepest.children[0]) {
      deepest = deepest.children[0];
      lengths.push(deepest.path.length);
    }

    assert.ok(
      lengths.every((length) => length <= maxPathSegments),
      `paths exceed ${maxPathSegments}: ${lengths.join(",")}`,
    );
    assert.deepEqual(deepest.path, [
      "…",
      ...Array.from({ length: maxPathSegments - 1 }, () => "span"),
    ]);
  }
});

function treeShape(node: SpanTreeNode): TreeShape {
  return {
    name: node.span.name,
    depth: node.depth,
    path: node.path,
    orphaned: node.orphaned,
    children: node.children.map(treeShape),
  };
}

function deepSpanChain(length: number): OtelSpan[] {
  return Array.from({ length }, (_, index) =>
    span({
      spanId: deepSpanId(index),
      parentSpanId: index === 0 ? null : deepSpanId(index - 1),
      name: "span",
      startedAt: at(index),
    }),
  );
}

function deepSpanId(index: number): string {
  return (index + 1).toString(16).padStart(16, "0");
}

function at(milliseconds: number): Date {
  return new Date(1_767_225_600_000 + milliseconds);
}

function span(overrides: Partial<OtelSpan> = {}): OtelSpan {
  return {
    id: "span-row",
    projectId: "project-1",
    receivedAt: new Date("2026-01-01T00:00:00.000Z"),
    traceId: "trace-1",
    spanId: "span",
    eventId: null,
    sourceId: null,
    parentSpanId: null,
    name: "span",
    kind: 1,
    spanClass: "other",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    endedAt: new Date("2026-01-01T00:00:00.001Z"),
    durationMs: 1,
    statusCode: 1,
    serviceName: null,
    scopeName: null,
    operationName: null,
    providerName: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    costUsd: null,
    searchOrigin: null,
    searchTarget: null,
    searchQuery: null,
    searchTopK: null,
    searchHitCount: null,
    experimentName: null,
    experimentArm: null,
    experimentRole: null,
    experimentAttrs: {},
    attributes: {},
    attrsTruncated: false,
    ...overrides,
  };
}
