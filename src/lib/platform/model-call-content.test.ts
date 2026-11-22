import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anthropicContent,
  contentAttributes,
  MODEL_CALL_CONTENT_MAX_CHARS,
} from "@/lib/platform/model-call-content";

test("an Anthropic request and answer map to gen_ai parts", () => {
  const content = anthropicContent({
    system: [{ type: "text", text: "Label the workflow." }],
    messages: [
      { role: "user", content: "Run 12 called search twice." },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ],
  });
  const answer = {
    content: [
      { type: "text", text: '{"label":"search"}' },
      { type: "tool_use", id: "tu_1", name: "lookup", input: { q: "x" } },
    ],
    stop_reason: "end_turn",
  };
  const attributes = contentAttributes(content, answer);

  assert.deepEqual(JSON.parse(String(attributes["gen_ai.system_instructions"])), [
    { type: "text", content: "Label the workflow." },
  ]);
  assert.deepEqual(JSON.parse(String(attributes["gen_ai.input.messages"])), [
    { role: "user", parts: [{ type: "text", content: "Run 12 called search twice." }] },
    { role: "assistant", parts: [{ type: "text", content: "ok" }] },
  ]);
  assert.deepEqual(JSON.parse(String(attributes["gen_ai.output.messages"])), [
    {
      role: "assistant",
      parts: [
        { type: "text", content: '{"label":"search"}' },
        { type: "tool_call", id: "tu_1", name: "lookup", arguments: { q: "x" } },
      ],
      finish_reason: "end_turn",
    },
  ]);
});

test("a string system prompt is one text part, and no answer means no output", () => {
  const attributes = contentAttributes(
    anthropicContent({ system: "Be brief.", messages: [{ role: "user", content: "hi" }] }),
  );
  assert.deepEqual(JSON.parse(String(attributes["gen_ai.system_instructions"])), [
    { type: "text", content: "Be brief." },
  ]);
  assert.equal(attributes["gen_ai.output.messages"], undefined);
});

test("each content attribute is capped, keeping the most recent messages and marking cuts", () => {
  const huge = "x".repeat(MODEL_CALL_CONTENT_MAX_CHARS * 2);
  const attributes = contentAttributes(
    anthropicContent({
      system: huge,
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: huge },
        { role: "user", content: "last" },
      ],
    }),
    { content: [{ type: "text", text: huge }], stop_reason: "max_tokens" },
  );
  for (const key of [
    "gen_ai.system_instructions",
    "gen_ai.input.messages",
    "gen_ai.output.messages",
  ]) {
    const value = String(attributes[key]);
    assert.ok(value.length <= MODEL_CALL_CONTENT_MAX_CHARS, `${key} is ${value.length} chars`);
    assert.ok(value.includes("[truncated]"), `${key} marks the cut`);
    JSON.parse(value);
  }
  const input = JSON.parse(String(attributes["gen_ai.input.messages"])) as Array<{
    parts: Array<{ content: string }>;
  }>;
  assert.equal(input.at(-1)!.parts[0]!.content, "last");
});
