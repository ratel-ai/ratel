import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttrMap, DecodedSpan } from "@/lib/ingest/otlp/types";
import {
  detectPropertyKeys,
  MAX_KEY_LENGTH,
  MAX_VALUE_LENGTH,
  propertyValues,
  storedPropertyNames,
} from "./keys";
import { standardPropertyOf } from "./standard";

const TRACE = "5b8efff798038103d269b633813fc60c";

function span(
  spanId: string,
  attributes: AttrMap,
  parentSpanId: string | null = null,
  resourceAttributes: AttrMap = {},
): DecodedSpan {
  return {
    traceId: TRACE,
    spanId,
    parentSpanId,
    name: "work",
    kind: 1,
    startUnixMs: 1,
    endUnixMs: 2,
    attributes,
    events: [],
    statusCode: 0,
    resourceAttributes,
    scopeName: null,
  };
}

test("an unknown scalar key is detected under its own name, a standard key under its canonical name", () => {
  const detected = detectPropertyKeys([
    span("1111111111111111", { "app.plan": "pro", "tenant.id": "acme", "user.id": "u-1" }),
    span("2222222222222222", { "app.plan": "free" }, "1111111111111111"),
  ]);
  assert.deepEqual(Object.fromEntries(detected), {
    "app.plan": { source: "user", count: 2 },
    organization: { source: "standard", count: 1 },
    user: { source: "standard", count: 1 },
  });
});

test("resource keys count once per resource, not once per span", () => {
  const resource = { "service.name": "api", "app.region": "eu" };
  const detected = detectPropertyKeys([
    span("1111111111111111", {}, null, resource),
    span("2222222222222222", {}, null, resource),
  ]);
  assert.deepEqual(detected.get("app.region"), { source: "user", count: 1 });
  assert.deepEqual(detected.get("service"), { source: "standard", count: 1 });
});

test("gen_ai, ratel, content, credential, address and non-scalar keys are never detected", () => {
  const detected = detectPropertyKeys([
    span("1111111111111111", {
      "gen_ai.operation.name": "chat",
      "gen_ai.input.messages": "[]",
      "ratel.search.query": "q",
      "input.value": "the prompt",
      "ai.prompt.messages": "[]",
      "app.prompt": "a prompt",
      "http.request.header.authorization": "Bearer x",
      "app.api_key": "k",
      "client.address": "10.0.0.1",
      "geo.location.lat": 1.5,
      "app.tags": ["a", "b"],
      "app.object": { a: 1 },
      "app.empty": "",
      [`app.${"k".repeat(MAX_KEY_LENGTH)}`]: "too long a key",
      "app.count": 3,
      "app.flag": true,
    }),
  ]);
  assert.deepEqual([...detected.keys()].sort(), ["app.count", "app.flag"]);
});

test("a gen_ai model key is the standard model property, mapped to its column", () => {
  const detected = detectPropertyKeys([span("1111111111111111", { "gen_ai.request.model": "m" })]);
  assert.deepEqual(detected.get("model"), { source: "standard", count: 1 });
  assert.equal(standardPropertyOf("gen_ai.request.model")?.column, "models");
  for (const [key, column] of [
    ["user.id", "end_user_id"],
    ["session.id", "session_id"],
    ["deployment.environment.name", "environment"],
  ] as const)
    assert.equal(standardPropertyOf(key)?.column, column, key);
  assert.equal(standardPropertyOf("tenant.id")?.name, "organization");
  assert.equal(standardPropertyOf("tenant.id")?.column, null);
  assert.equal(standardPropertyOf("service.version")?.name, "release");
});

test("stored names leave out the properties a summary column already holds", () => {
  assert.deepEqual(
    [
      ...storedPropertyNames([
        "user",
        "session",
        "environment",
        "model",
        "service",
        "organization",
        "app.plan",
      ]),
    ].sort(),
    ["app.plan", "organization"],
  );
});

test("values: one per indexed name, resolved up the tree and the resource, cut to 256 characters", () => {
  const long = "x".repeat(MAX_VALUE_LENGTH + 10);
  const values = propertyValues(
    [
      span("1111111111111111", { "tenant.id": "acme", "app.note": long }, null, {
        "app.region": "eu",
      }),
      span("2222222222222222", { "app.plan": 3, "customer.id": "other" }, "1111111111111111", {
        "app.region": "eu",
      }),
    ],
    new Set(["organization", "app.plan", "app.region", "app.note", "user", "app.absent"]),
  );
  assert.deepEqual(values.get("1111111111111111"), {
    organization: "acme",
    "app.region": "eu",
    "app.note": "x".repeat(MAX_VALUE_LENGTH),
  });
  // The child's own value first, then its ancestors: the organization of the root, a key the
  // child carries itself (customer.id) ranks below the root's tenant.id only by key priority.
  assert.deepEqual(values.get("2222222222222222"), {
    organization: "other",
    "app.plan": "3",
    "app.region": "eu",
    "app.note": "x".repeat(MAX_VALUE_LENGTH),
  });
});

test("values: a non-scalar value is never stored, and a span without values has no entry", () => {
  const values = propertyValues(
    [span("1111111111111111", { "app.plan": ["a"] }), span("2222222222222222", {})],
    new Set(["app.plan"]),
  );
  assert.equal(values.size, 0);
});
