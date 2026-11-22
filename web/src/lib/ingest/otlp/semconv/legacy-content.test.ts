import assert from "node:assert/strict";
import { test } from "node:test";
import { loadFixture } from "@/lib/ledger/turns/real-fixtures";
import { decodeOtlp } from "../decode";
import { groupSpans } from "../group";
import { toRow } from "../reconstruct";
import type { AttrMap, DecodedEvent, DecodedSpan } from "../types";
import { normalizeSemconvAliases } from "./aliases";
import { mapLegacyContent } from "./legacy-content";

/**
 * OpenLLMetry indexed prompt/completion
 * keys and per-message span events become `gen_ai.*` messages.
 */

function span(attributes: AttrMap, events: DecodedEvent[] = []): DecodedSpan {
  return {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    parentSpanId: null,
    name: "openai.chat",
    kind: 3,
    startUnixMs: Date.UTC(2026, 10, 1),
    endUnixMs: Date.UTC(2026, 10, 1) + 800,
    attributes,
    events,
    statusCode: 0,
    resourceAttributes: {},
    scopeName: null,
  };
}

const event = (name: string, attributes: AttrMap): DecodedEvent => ({
  name,
  timeUnixMs: 0,
  attributes,
});
const json = (s: DecodedSpan, key: string): unknown => {
  const value = s.attributes[key];
  return typeof value === "string" ? JSON.parse(value) : undefined;
};

/* --- indexed keys -------------------------------------------------------------- */

test("indexed prompt and completion keys become v1.41 messages", () => {
  const s = span({
    "gen_ai.prompt.0.role": "system",
    "gen_ai.prompt.0.content": "Be terse.",
    "gen_ai.prompt.1.role": "user",
    "gen_ai.prompt.1.content": "Find the bug",
    "gen_ai.prompt.2.role": "assistant",
    "gen_ai.prompt.2.tool_calls.0.id": "c1",
    "gen_ai.prompt.2.tool_calls.0.name": "search",
    "gen_ai.prompt.2.tool_calls.0.arguments": '{"q":"bug"}',
    "gen_ai.prompt.3.role": "tool",
    "gen_ai.prompt.3.tool_call_id": "c1",
    "gen_ai.prompt.3.content": "FAL-12",
    "gen_ai.completion.0.role": "assistant",
    "gen_ai.completion.0.content": "Found FAL-12",
    "gen_ai.completion.0.finish_reason": "stop",
    "gen_ai.completion.0.tool_calls.0.id": "c2",
    "gen_ai.completion.0.tool_calls.0.name": "assign",
    "gen_ai.completion.0.tool_calls.0.arguments": '{"id":"FAL-12"}',
  });
  mapLegacyContent(s);
  assert.deepEqual(json(s, "gen_ai.system_instructions"), [{ type: "text", content: "Be terse." }]);
  assert.deepEqual(json(s, "gen_ai.input.messages"), [
    { role: "user", parts: [{ type: "text", content: "Find the bug" }] },
    {
      role: "assistant",
      parts: [{ type: "tool_call", id: "c1", name: "search", arguments: { q: "bug" } }],
    },
    { role: "tool", parts: [{ type: "tool_call_response", id: "c1", response: "FAL-12" }] },
  ]);
  assert.deepEqual(json(s, "gen_ai.output.messages"), [
    {
      role: "assistant",
      parts: [
        { type: "text", content: "Found FAL-12" },
        { type: "tool_call", id: "c2", name: "assign", arguments: { id: "FAL-12" } },
      ],
      finish_reason: "stop",
    },
  ]);
  // The legacy keys stay; a second pass changes nothing.
  assert.equal(s.attributes["gen_ai.prompt.1.content"], "Find the bug");
  const once = { ...s.attributes };
  mapLegacyContent(s);
  assert.deepEqual(s.attributes, once);
});

test("indexes sort numerically and JSON content parts are read", () => {
  const attrs: AttrMap = {};
  for (let i = 0; i < 11; i++) {
    attrs[`gen_ai.prompt.${i}.role`] = "user";
    attrs[`gen_ai.prompt.${i}.content`] = `m${i}`;
  }
  attrs["gen_ai.prompt.11.content"] = JSON.stringify([
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "https://x/y.png" } },
  ]);
  const s = span(attrs);
  mapLegacyContent(s);
  const input = json(s, "gen_ai.input.messages") as {
    parts: { content?: string; uri?: string }[];
  }[];
  assert.deepEqual(
    input.slice(0, 11).map((m) => m.parts[0].content),
    [...Array(11).keys()].map((i) => `m${i}`),
  );
  assert.deepEqual(input[11].parts, [
    { type: "text", content: "look" },
    { type: "uri", modality: "image", uri: "https://x/y.png" },
  ]);
});

test("existing gen_ai.input.messages always wins, on the span or the details event", () => {
  const legacy = {
    "gen_ai.prompt.0.role": "system",
    "gen_ai.prompt.0.content": "sys",
    "gen_ai.prompt.1.content": "old",
  };
  const kept = '[{"role":"user","parts":[{"type":"text","content":"new"}]}]';
  const onSpan = span({ ...legacy, "gen_ai.input.messages": kept });
  mapLegacyContent(onSpan);
  assert.equal(onSpan.attributes["gen_ai.input.messages"], kept);
  assert.equal(onSpan.attributes["gen_ai.system_instructions"], undefined);

  const onEvent = span({ ...legacy }, [
    event("gen_ai.client.inference.operation.details", { "gen_ai.input.messages": kept }),
  ]);
  mapLegacyContent(onEvent);
  assert.equal(onEvent.attributes["gen_ai.input.messages"], undefined);
  assert.equal(onEvent.attributes["gen_ai.system_instructions"], undefined);
});

/* --- span events ----------------------------------------------------------------- */

test("per-message span events become messages in event order", () => {
  const s = span({}, [
    event("gen_ai.system.message", { content: "Be terse." }),
    event("gen_ai.user.message", { content: "Find the bug" }),
    event("gen_ai.assistant.message", {
      tool_calls: [
        { id: "c1", type: "function", function: { name: "search", arguments: '{"q":"bug"}' } },
      ],
    }),
    event("gen_ai.tool.message", { content: "FAL-12", id: "c1" }),
    event("gen_ai.choice", {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "Found FAL-12" },
    }),
  ]);
  mapLegacyContent(s);
  assert.deepEqual(json(s, "gen_ai.system_instructions"), [{ type: "text", content: "Be terse." }]);
  assert.deepEqual(json(s, "gen_ai.input.messages"), [
    { role: "user", parts: [{ type: "text", content: "Find the bug" }] },
    {
      role: "assistant",
      parts: [{ type: "tool_call", id: "c1", name: "search", arguments: { q: "bug" } }],
    },
    { role: "tool", parts: [{ type: "tool_call_response", id: "c1", response: "FAL-12" }] },
  ]);
  assert.deepEqual(json(s, "gen_ai.output.messages"), [
    {
      role: "assistant",
      parts: [{ type: "text", content: "Found FAL-12" }],
      finish_reason: "stop",
    },
  ]);
});

test("events whose tool_calls and message are JSON strings are read", () => {
  const s = span({}, [
    event("gen_ai.assistant.message", {
      tool_calls: JSON.stringify([{ id: "c1", function: { name: "search", arguments: "{}" } }]),
    }),
    event("gen_ai.choice", { message: JSON.stringify({ content: "ok" }), finish_reason: "stop" }),
  ]);
  mapLegacyContent(s);
  assert.deepEqual(json(s, "gen_ai.input.messages"), [
    { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "search", arguments: {} }] },
  ]);
  assert.deepEqual(json(s, "gen_ai.output.messages"), [
    { role: "assistant", parts: [{ type: "text", content: "ok" }], finish_reason: "stop" },
  ]);
});

test("bad shapes are skipped and a span with no content is unchanged", () => {
  const s = span({ "gen_ai.prompt.0.content": 7, "gen_ai.prompt.x.content": "no index" }, [
    event("gen_ai.user.message", { content: null }),
    event("gen_ai.choice", { message: "{broken" }),
  ]);
  mapLegacyContent(s);
  assert.deepEqual(Object.keys(s.attributes).sort(), [
    "gen_ai.prompt.0.content",
    "gen_ai.prompt.x.content",
  ]);
});

/* --- real fixture -------------------------------------------------------------- */

/**
 * The `openllmetry-openai` fixture (traceloop 0.62) already sends v1.41
 * messages. Older OpenLLMetry sends the same content as indexed keys, so the
 * fixture is rewritten into that form: with the alias pass it must split as the
 * original does. Without it no message is seen: no history, no user input (the
 * fixture's small inputs all go to the tool catalog).
 */
function toIndexedKeys(s: DecodedSpan): DecodedSpan {
  const attrs = { ...s.attributes };
  const take = (key: string) => {
    const value = attrs[key];
    delete attrs[key];
    return typeof value === "string"
      ? (JSON.parse(value) as {
          role: string;
          parts: Record<string, unknown>[];
          finish_reason?: string;
        }[])
      : [];
  };
  for (const [side, key] of [
    ["prompt", "gen_ai.input.messages"],
    ["completion", "gen_ai.output.messages"],
  ] as const) {
    take(key).forEach((message, i) => {
      const prefix = `gen_ai.${side}.${i}`;
      attrs[`${prefix}.role`] = message.role;
      if (message.finish_reason) attrs[`${prefix}.finish_reason`] = message.finish_reason;
      let call = 0;
      for (const part of message.parts) {
        if (part.type === "text") attrs[`${prefix}.content`] = part.content as string;
        if (part.type === "tool_call_response") {
          attrs[`${prefix}.tool_call_id`] = part.id as string;
          attrs[`${prefix}.content`] =
            typeof part.response === "string" ? part.response : JSON.stringify(part.response);
        }
        if (part.type === "tool_call") {
          attrs[`${prefix}.tool_calls.${call}.id`] = part.id as string;
          attrs[`${prefix}.tool_calls.${call}.name`] = part.name as string;
          attrs[`${prefix}.tool_calls.${call}.arguments`] = JSON.stringify(part.arguments);
          call += 1;
        }
      }
    });
  }
  return { ...s, attributes: attrs };
}

function splits(transform: (spans: DecodedSpan[]) => DecodedSpan[]) {
  return loadFixture("openllmetry-openai").flatMap((body) =>
    groupSpans(transform(decodeOtlp(body.contentType, body.bytes))).map(
      (call) => toRow("p1", call).metric.tokensByCategory,
    ),
  );
}

test("openllmetry-openai as indexed keys: history and user_input as with v1.41 messages", () => {
  const original = splits((spans) => spans);
  const legacyOff = splits((spans) => spans.map(toIndexedKeys));
  const legacyOn = splits((spans) => normalizeSemconvAliases(spans.map(toIndexedKeys)));
  assert.equal(original.length, 11);
  assert.ok(
    legacyOff.every((t) => t.history === 0 && t.user_input === 0),
    "flag off: no messages seen",
  );
  assert.ok(
    legacyOn.some((t) => t.history > 0),
    "flag on: history above 0",
  );
  assert.ok(
    legacyOn.some((t) => t.user_input > 0),
    "flag on: user_input above 0",
  );
  assert.deepEqual(legacyOn, original);
});

test("content that is a JSON array but not content parts stays as text", () => {
  const list = '[{"title":"A","url":"u"}]';
  const s = span({
    "gen_ai.prompt.0.role": "user",
    "gen_ai.prompt.0.content": "[1, 2, 3]",
    "gen_ai.prompt.1.role": "tool",
    "gen_ai.prompt.1.tool_call_id": "c1",
    "gen_ai.prompt.1.content": list,
  });
  mapLegacyContent(s);
  assert.deepEqual(json(s, "gen_ai.input.messages"), [
    { role: "user", parts: [{ type: "text", content: "[1, 2, 3]" }] },
    { role: "tool", parts: [{ type: "tool_call_response", id: "c1", response: list }] },
  ]);
});

test("a second pass over converted events changes nothing", () => {
  const s = span({}, [
    event("gen_ai.user.message", { content: "hi" }),
    event("gen_ai.choice", { message: { content: "ok" } }),
  ]);
  mapLegacyContent(s);
  const once = { ...s.attributes };
  mapLegacyContent(s);
  assert.deepEqual(s.attributes, once);
});
