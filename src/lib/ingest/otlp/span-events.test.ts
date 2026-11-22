import assert from "node:assert/strict";
import { test } from "node:test";
import { storedSpanEvents, storedSpanLinks } from "./span-events";
import { toOtelSpanRows } from "./span-rows";
import type { DecodedSpan } from "./types";

function span(overrides: Partial<DecodedSpan> = {}): DecodedSpan {
  return {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    parentSpanId: null,
    name: "invoke_agent claude",
    kind: 1,
    startUnixMs: 1_750_000_000_000,
    endUnixMs: 1_750_000_060_000,
    attributes: {},
    events: [],
    statusCode: 1,
    resourceAttributes: {},
    scopeName: "beluga",
    ...overrides,
  };
}

const COMPACTION = {
  name: "ratel.compaction",
  timeUnixMs: 1_750_000_020_000,
  attributes: {
    "ratel.compaction.trigger": "auto",
    "ratel.compaction.pre_tokens": 180_000,
    "ratel.compaction.post_tokens": 42_000,
  },
};

test("keeps a span event with its name, time and content-free attributes", () => {
  const { value, truncated } = storedSpanEvents(span({ events: [COMPACTION] }));
  assert.deepEqual(value, [COMPACTION]);
  assert.equal(truncated, false);
});

test("drops an event that carries only content, and strips content keys from the others", () => {
  const { value } = storedSpanEvents(
    span({
      events: [
        {
          name: "gen_ai.client.inference.operation.details",
          timeUnixMs: 1,
          attributes: { "gen_ai.input.messages": "[]", "gen_ai.output.messages": "[]" },
        },
        {
          name: "ratel.permission.decision",
          timeUnixMs: 2,
          attributes: {
            "gen_ai.tool.name": "Bash:git",
            "ratel.permission.decision": "allow",
            "gen_ai.tool.call.arguments": "{}",
            "http.url": "x",
          },
        },
        { name: "marker", timeUnixMs: 3, attributes: {} },
      ],
    }),
  );
  assert.deepEqual(value, [
    {
      name: "ratel.permission.decision",
      timeUnixMs: 2,
      attributes: { "gen_ai.tool.name": "Bash:git", "ratel.permission.decision": "allow" },
    },
    { name: "marker", timeUnixMs: 3, attributes: {} },
  ]);
});

test("the question asked in a wait for a person is content", () => {
  const { value } = storedSpanEvents(
    span({
      events: [
        {
          name: "ratel.human.wait",
          timeUnixMs: 1,
          attributes: { "ratel.wait.kind": "question", "ratel.wait.question": "Which branch?" },
        },
      ],
    }),
  );
  assert.deepEqual(value, [
    { name: "ratel.human.wait", timeUnixMs: 1, attributes: { "ratel.wait.kind": "question" } },
  ]);
});

test("a span with no event stores null", () => {
  assert.deepEqual(storedSpanEvents(span()), { value: null, truncated: false });
});

test("bounds the number of events and reports the cut", () => {
  const events = Array.from({ length: 300 }, (_, index) => ({
    name: "ratel.hook",
    timeUnixMs: index,
    attributes: { "ratel.hook.name": `hook-${index}` },
  }));
  const { value, truncated } = storedSpanEvents(span({ events }));
  assert.equal(value?.length, 256);
  assert.equal(truncated, true);
});

test("bounds the bytes of the stored events", () => {
  const events = Array.from({ length: 100 }, (_, index) => ({
    name: "ratel.human.wait",
    timeUnixMs: index,
    attributes: { "ratel.hook.name": "q".repeat(1_000) },
  }));
  const { value, truncated } = storedSpanEvents(span({ events }));
  assert.ok(value && value.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") <= 32 * 1024);
  assert.equal(truncated, true);
});

test("keeps a span link with valid ids and its content-free attributes", () => {
  const { value } = storedSpanLinks(
    span({
      links: [
        {
          traceId: "ABCDEFabcdef0123456789abcdef0123",
          spanId: "fedcba9876543210",
          attributes: { "ratel.link.kind": "background_task", "gen_ai.input.messages": "[]" },
        },
        { traceId: "", spanId: "fedcba9876543210", attributes: {} },
        { traceId: "abcdefabcdef0123456789abcdef0123", spanId: "0000000000000000", attributes: {} },
      ],
    }),
  );
  assert.deepEqual(value, [
    {
      traceId: "abcdefabcdef0123456789abcdef0123",
      spanId: "fedcba9876543210",
      attributes: { "ratel.link.kind": "background_task" },
    },
  ]);
});

test("a span with no link stores null", () => {
  assert.deepEqual(storedSpanLinks(span()), { value: null, truncated: false });
  assert.deepEqual(storedSpanLinks(span({ links: [] })), { value: null, truncated: false });
});

test("a span row stores its events and links", () => {
  const input = span({
    events: [COMPACTION],
    links: [
      { traceId: "abcdefabcdef0123456789abcdef0123", spanId: "fedcba9876543210", attributes: {} },
    ],
  });
  const [row] = toOtelSpanRows("project-1", [input]);
  assert.deepEqual(row.events, [COMPACTION]);
  assert.deepEqual(row.links, [
    { traceId: "abcdefabcdef0123456789abcdef0123", spanId: "fedcba9876543210", attributes: {} },
  ]);
  assert.equal(row.attrsTruncated, false);
});
