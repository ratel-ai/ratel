import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeAgentSdkTrace } from "./agent-span-fixtures";
import { MAX_PIVOT_VALUE_BYTES, toOtelSpanRows } from "./span-rows";
import type { DecodedSpan } from "./types";

/** RC-883: a span row keeps the project's configured pivot keys, from the span or else its resource. */

function span(overrides: Partial<DecodedSpan> = {}): DecodedSpan {
  return {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    parentSpanId: null,
    name: "agent turn",
    kind: 1,
    startUnixMs: 1_750_000_000_125,
    endUnixMs: 1_750_000_000_250,
    attributes: {},
    events: [],
    statusCode: 1,
    resourceAttributes: {},
    scopeName: "agent",
    ...overrides,
  };
}

const TENANT = new Set(["tenant.id"]);

test("a configured key only on the resource is kept in attributes", () => {
  const [row] = toOtelSpanRows(
    "p",
    [span({ resourceAttributes: { "tenant.id": "acme", "host.name": "h1" } })],
    undefined,
    {
      pivotKeys: TENANT,
    },
  );
  assert.deepEqual(row.attributes, { "tenant.id": "acme" });
});

test("the span's value wins over the resource's", () => {
  const [row] = toOtelSpanRows(
    "p",
    [span({ attributes: { "tenant.id": "globex" }, resourceAttributes: { "tenant.id": "acme" } })],
    undefined,
    { pivotKeys: TENANT },
  );
  assert.equal(row.attributes["tenant.id"], "globex");
});

test("only scalar, non-empty values; a long string is cut; unconfigured keys stay dropped", () => {
  const [row] = toOtelSpanRows(
    "p",
    [
      span({
        attributes: {
          "tenant.id": "  ",
          "customer.tier": 3,
          "beta.user": true,
          "list.key": ["a", "b"],
          other: "x",
        },
        resourceAttributes: { "tenant.id": "acme", "long.key": "y".repeat(1000) },
      }),
    ],
    undefined,
    { pivotKeys: new Set(["tenant.id", "customer.tier", "beta.user", "list.key", "long.key"]) },
  );
  assert.deepEqual(row.attributes, {
    "tenant.id": "acme",
    "customer.tier": 3,
    "beta.user": true,
    "long.key": "y".repeat(MAX_PIVOT_VALUE_BYTES),
  });
});

test("no pivot keys, or an empty set, store the same rows as before", () => {
  const spans = claudeAgentSdkTrace().map((entry) => ({
    ...entry,
    attributes: { ...entry.attributes, "tenant.id": "globex" },
    resourceAttributes: { ...entry.resourceAttributes, "tenant.id": "acme" },
  }));
  const before = toOtelSpanRows("p", spans);
  assert.deepEqual(toOtelSpanRows("p", spans, undefined, { pivotKeys: new Set() }), before);
  assert.ok(before.every((row) => !("tenant.id" in row.attributes)));
});
