import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formFromEval,
  generatedAfterEdit,
  parseEvalForm,
  parseSpecForm,
  type SpecForm,
  specChanges,
} from "../domain/edit";
import type { Eval } from "../domain/types";

const NOW = new Date("2026-11-13T10:00:00Z");
const TOOLS = [
  {
    name: "find_booking",
    description: "Finds a booking.",
    parameters: { type: "object", properties: { ref: { type: "string" } } },
  },
];
const ITEM: Eval = {
  id: "e",
  projectId: "p",
  name: "Aisle seat",
  sourceTurnId: null,
  sourceCaseId: null,
  message: "Move me to an aisle seat",
  earlierMessages: [],
  turns: [],
  checks: {},
  expectedTool: null,
  criteria: "",
  fixedAnswers: [],
  systemPrompt: "You are a travel agent.",
  tools: TOOLS,
  context: { booking: "R1" },
  generated: ["systemPrompt", "tools", "context"],
  status: "approved",
  origin: "user",
  tasks: [],
  createdBy: "u",
  createdAt: NOW,
  updatedAt: NOW,
};
const spec = (over: Partial<SpecForm> = {}): SpecForm => ({
  ...formFromEval(ITEM, []).spec!,
  ...over,
});
const changesOf = (over: Partial<SpecForm>) => {
  const parsed = parseSpecForm(spec(over));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return specChanges(ITEM, parsed.value);
};

test("RC-641: the form of an eval reads back to the same spec, and an unchanged spec changes no field", () => {
  const parsed = parseEvalForm(formFromEval(ITEM, []));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.deepEqual(parsed.value.spec, {
    message: ITEM.message,
    systemPrompt: ITEM.systemPrompt,
    tools: TOOLS,
    context: ITEM.context,
  });
  assert.deepEqual(specChanges(ITEM, parsed.value.spec!), {});
});

test("RC-641: each spec field edit changes only that field", () => {
  assert.deepEqual(changesOf({ systemPrompt: "  Be brief.  " }), { systemPrompt: "Be brief." });
  assert.deepEqual(changesOf({ message: "Move me to a window seat" }), {
    message: "Move me to a window seat",
  });
  assert.deepEqual(changesOf({ tools: '[{"name": "select_seat"}]' }), {
    tools: [
      { name: "select_seat", description: "", parameters: { type: "object", properties: {} } },
    ],
  });
  assert.deepEqual(changesOf({ context: '{"booking": "R2"}' }), { context: { booking: "R2" } });
});

test("RC-641: empty text clears the system prompt, the tools and the context", () => {
  assert.deepEqual(changesOf({ systemPrompt: " ", tools: "", context: "" }), {
    systemPrompt: null,
    tools: null,
    context: null,
  });
});

test("RC-641: the same JSON in another key order is no change", () => {
  const reordered = JSON.stringify([
    {
      parameters: { properties: { ref: { type: "string" } }, type: "object" },
      description: "Finds a booking.",
      name: "find_booking",
    },
  ]);
  assert.deepEqual(changesOf({ tools: reordered }), {});
});

test("RC-641: a bad spec says what is wrong", () => {
  const error = (over: Partial<SpecForm>) => {
    const parsed = parseSpecForm(spec(over));
    return parsed.ok ? null : parsed.error;
  };
  assert.equal(error({ message: " " }), "Write the message the agent gets.");
  assert.match(error({ tools: "{}" })!, /The tools must be a JSON list/);
  assert.equal(error({ tools: '[{"description": "x"}]' }), "Tool 1: give it a name.");
  assert.equal(
    error({ tools: '[{"name": "a", "parameters": []}]' }),
    "Tool 1: the parameters must be a JSON object.",
  );
  assert.match(
    error({ context: '{"booking": 1}' })!,
    /The context must be a JSON object of text values/,
  );
  assert.match(error({ context: "[1]" })!, /The context must be a JSON object/);
});

test("RC-641: an edited spec field leaves the generated list, the others stay", () => {
  assert.deepEqual(
    generatedAfterEdit(
      ["systemPrompt", "tools", "context"],
      Object.keys(changesOf({ systemPrompt: "Be brief." })),
    ),
    ["tools", "context"],
  );
  assert.deepEqual(
    generatedAfterEdit(
      ["systemPrompt", "tools", "context"],
      Object.keys(changesOf({ tools: "", context: '{"a": "b"}' })),
    ),
    ["systemPrompt"],
  );
  assert.deepEqual(
    generatedAfterEdit(["message"], Object.keys(changesOf({ message: "Another ask" }))),
    [],
  );
  assert.deepEqual(generatedAfterEdit(["systemPrompt"], []), ["systemPrompt"]);
});

test("RC-641: a form without the spec parses as before", () => {
  const { spec: _spec, ...form } = formFromEval(ITEM, []);
  const parsed = parseEvalForm(form);
  assert.ok(parsed.ok);
  assert.equal("spec" in parsed.value, false);
});

test("RC-642: an eval whose recorded ask was not captured has no spec in its form, so Save still works", () => {
  const form = formFromEval({ ...ITEM, message: "" }, []);
  assert.equal(form.spec, undefined);
  assert.ok(parseEvalForm(form).ok);
});
