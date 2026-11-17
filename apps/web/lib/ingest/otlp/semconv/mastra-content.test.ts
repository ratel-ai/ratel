import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import { loadFixture } from "@/lib/ledger/turns/real-fixtures";
import { decodeOtlp } from "../decode";
import { deriveToolInvocations } from "../derive-tools";
import { groupSpans } from "../group";
import { normalizeAiSdkSpans } from "../normalize-ai-sdk";
import { toRows } from "../reconstruct";
import type { AttrMap, DecodedSpan } from "../types";
import { normalizeSemconvAliases } from "./aliases";
import { mapMastraInput } from "./mastra-content";

/**
 * The real Mastra fixture
 * (`@mastra/otel-exporter` 1.4.4) carries its input on the spans around the
 * `chat` anchor. It reaches `events.payload`.
 */

function ingest(flag: boolean) {
  const rows = [];
  let tools = 0;
  for (const body of loadFixture("mastra")) {
    const spans = decodeOtlp(body.contentType, body.bytes);
    normalizeAiSdkSpans(spans);
    if (flag) normalizeSemconvAliases(spans);
    rows.push(...toRows("p1", groupSpans(spans)));
    tools += deriveToolInvocations(spans).length;
  }
  rows.sort((a, b) => (a.event.occurredAt?.getTime() ?? 0) - (b.event.occurredAt?.getTime() ?? 0));
  return { rows, tools };
}

const textOf = (m: CloudMessage): string =>
  typeof m.content === "string"
    ? m.content
    : m.content.map((b) => (b.type === "text" ? b.text : "")).join("");

test("flag on: events.payload carries the system, user and assistant messages", () => {
  const { rows } = ingest(true);
  const payloads = rows.map((r) => r.event.payload as CloudEvent);
  assert.equal(payloads.length, 11);
  for (const p of payloads) {
    assert.match(p.system ?? "", /project-management assistant/);
    assert.ok(
      p.messages.some((m) => m.role === "user" && textOf(m) !== ""),
      "user message",
    );
  }
  assert.equal(
    textOf(payloads[0].messages.find((m) => m.role === "user")!),
    "Find the Falcon login bug and assign it to Ada",
  );
  // The run's last call: earlier assistant turns as history, its reply as output.
  const last = payloads[3].messages.filter((m) => m.role === "assistant").map(textOf);
  assert.ok(last.includes("[tool: search_tasks]"), "history assistant message");
  assert.equal(last.at(-1), "Done: FAL-12 (Falcon login bug) is now assigned to Ada.");
});

test("flag off: no user message reaches events.payload", () => {
  const { rows } = ingest(false);
  for (const r of rows) {
    const p = r.event.payload as CloudEvent;
    assert.equal(p.system, undefined);
    assert.ok(!p.messages.some((m) => m.role === "user" && textOf(m) !== ""));
  }
});

test("token, tool and run counts do not change", () => {
  const on = ingest(true);
  const off = ingest(false);
  assert.equal(on.rows.length, off.rows.length);
  assert.equal(on.tools, off.tools);
  assert.deepEqual(
    on.rows.map((r) => [r.event.traceId, r.event.inputTokens, r.event.outputTokens]),
    off.rows.map((r) => [r.event.traceId, r.event.inputTokens, r.event.outputTokens]),
  );
});

/* --- unit contract ------------------------------------------------------------ */

function span(spanId: string, parentSpanId: string | null, attributes: AttrMap): DecodedSpan {
  return {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId,
    parentSpanId,
    name: spanId,
    kind: 1,
    startUnixMs: 0,
    endUnixMs: 1,
    attributes,
    events: [],
    statusCode: 0,
    resourceAttributes: {},
    scopeName: null,
  };
}

const STEP_INPUT = JSON.stringify([
  { role: "system", content: "sys" },
  { role: "user", content: "step ask" },
]);

function tree(chat: AttrMap, step: AttrMap = { "mastra.model_step.input": STEP_INPUT }) {
  const spans = [
    span("generation", null, {
      "mastra.model_generation.input": JSON.stringify({
        messages: [{ role: "user", content: [{ type: "text", text: "first ask" }] }],
      }),
    }),
    span("step", "generation", step),
    span("chat", "step", { "gen_ai.operation.name": "chat", ...chat }),
  ];
  return { chat: spans[2], byId: new Map(spans.map((s) => [s.spanId, s])) };
}

test("the nearest step input wins and the system message goes to the instructions", () => {
  const { chat, byId } = tree({});
  mapMastraInput(chat, byId);
  assert.deepEqual(JSON.parse(chat.attributes["gen_ai.input.messages"] as string), [
    { role: "user", parts: [{ type: "text", content: "step ask" }] },
  ]);
  assert.deepEqual(JSON.parse(chat.attributes["gen_ai.system_instructions"] as string), [
    { type: "text", content: "sys" },
  ]);
});

test("without a step input the generation input is read", () => {
  const { chat, byId } = tree({}, {});
  mapMastraInput(chat, byId);
  assert.deepEqual(JSON.parse(chat.attributes["gen_ai.input.messages"] as string), [
    { role: "user", parts: [{ type: "text", content: "first ask" }] },
  ]);
});

test("existing gen_ai.input.messages and system instructions win", () => {
  const kept = '[{"role":"user","parts":[{"type":"text","content":"kept"}]}]';
  const { chat, byId } = tree({ "gen_ai.input.messages": kept });
  mapMastraInput(chat, byId);
  assert.equal(chat.attributes["gen_ai.input.messages"], kept);
  assert.equal(chat.attributes["gen_ai.system_instructions"], undefined);

  const withSystem = tree({ "gen_ai.system_instructions": "own" });
  mapMastraInput(withSystem.chat, withSystem.byId);
  assert.equal(withSystem.chat.attributes["gen_ai.system_instructions"], "own");
  assert.ok(withSystem.chat.attributes["gen_ai.input.messages"]);
});

test("a span with no Mastra input around it is unchanged", () => {
  const chat = span("chat", null, { "gen_ai.operation.name": "chat" });
  mapMastraInput(chat, new Map([["chat", chat]]));
  assert.deepEqual(chat.attributes, { "gen_ai.operation.name": "chat" });
});

test("a model call under a tool does not take the Mastra step's input", () => {
  const spans = [
    span("step", null, { "mastra.model_step.input": STEP_INPUT }),
    span("tool", "step", {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "sub_agent",
    }),
    span("sub", "tool", { "gen_ai.operation.name": "chat" }),
  ];
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  mapMastraInput(spans[2], byId);
  assert.equal(spans[2].attributes["gen_ai.input.messages"], undefined);
});

test("a model call under another model call does not take its input", () => {
  const spans = [
    span("step", null, { "mastra.model_step.input": STEP_INPUT }),
    span("outer", "step", { "gen_ai.operation.name": "chat" }),
    span("inner", "outer", { "gen_ai.operation.name": "chat" }),
  ];
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  mapMastraInput(spans[2], byId);
  assert.equal(spans[2].attributes["gen_ai.input.messages"], undefined);
});

test("a second pass changes nothing", () => {
  const { chat, byId } = tree({});
  mapMastraInput(chat, byId);
  const once = { ...chat.attributes };
  mapMastraInput(chat, byId);
  assert.deepEqual(chat.attributes, once);
});
