import assert from "node:assert/strict";
import { test } from "node:test";
import type { RatelYaml } from "../domain/config";
import { configurationProblems, versionSpec } from "../page-model";
import {
  expectedOutputOf,
  inputDraftOf,
  inputOfDraft,
  type ParamSpec,
  paramDraftOf,
  paramsOfDraft,
} from "../run-form";

const CONFIG: RatelYaml = {
  name: "support-demo",
  run: { mode: "command", command: ["node", "agent.js"], timeoutSeconds: 90 },
  input: { example: { message: "Where is my order?" } },
  params: {
    model: {
      type: "enum",
      options: ["small", "large"],
      default: "small",
      description: "The model",
    },
    temperature: { type: "number", default: 0.2 },
    strict: { type: "boolean" },
    persona: { type: "string", description: "Who answers" },
  },
  tools: { lookup_order: { mode: "live" }, refund_order: {} },
};
const SPECS: ParamSpec[] = versionSpec(CONFIG).params;

test("the spec of a version has its example, its params, its tools with modes and its run mode", () => {
  const spec = versionSpec(CONFIG);
  assert.deepEqual(spec.inputExample, { message: "Where is my order?" });
  assert.deepEqual(spec.params[0], {
    name: "model",
    type: "enum",
    default: "small",
    description: "The model",
    options: ["small", "large"],
  });
  assert.deepEqual(spec.params[2], {
    name: "strict",
    type: "boolean",
    default: null,
    description: null,
    options: [],
  });
  assert.deepEqual(spec.tools, [
    { name: "lookup_order", mode: "live" },
    { name: "refund_order", mode: "simulated" },
  ]);
  assert.equal(spec.runMode, "command");
  assert.equal(spec.timeoutSeconds, 90);
  const bare = versionSpec({ name: "bare", input: { example: null } });
  assert.deepEqual(bare, {
    inputExample: null,
    params: [],
    tools: [],
    runMode: "http",
    timeoutSeconds: null,
  });
});

test("the form starts at the defaults: a switch is off without one", () => {
  assert.deepEqual(paramDraftOf(SPECS), {
    model: "small",
    temperature: "0.2",
    strict: false,
    persona: "",
  });
});

test("the params of a run are typed as declared, and an empty field keeps the default", () => {
  const result = paramsOfDraft(SPECS, {
    model: "large",
    temperature: "0.7",
    strict: true,
    persona: "",
  });
  assert.deepEqual(result, { ok: true, value: { model: "large", temperature: 0.7, strict: true } });
  const numeric: ParamSpec = { ...SPECS[0], name: "size", options: [1, 2] };
  assert.deepEqual(paramsOfDraft([numeric], { size: "2" }), { ok: true, value: { size: 2 } });
});

test("a number that does not parse and an unknown option are refused with the param name", () => {
  const result = paramsOfDraft(SPECS, { model: "huge", temperature: "warm", strict: false });
  assert.deepEqual(result, {
    ok: false,
    errors: {
      model: "model must be one of: small, large.",
      temperature: "temperature must be a number.",
    },
  });
});

test("a string example is edited as text, any other example as JSON", () => {
  assert.deepEqual(inputDraftOf("hi"), { kind: "text", text: "hi" });
  assert.deepEqual(inputDraftOf({ a: 1 }), { kind: "json", text: '{\n  "a": 1\n}' });
  assert.deepEqual(inputDraftOf(undefined), { kind: "json", text: "null" });
  assert.deepEqual(inputOfDraft({ kind: "text", text: "{" }), { ok: true, value: "{" });
  assert.deepEqual(inputOfDraft({ kind: "json", text: '{"a":1}' }), { ok: true, value: { a: 1 } });
  assert.deepEqual(inputOfDraft({ kind: "json", text: "{" }), {
    ok: false,
    error: "The input must be JSON.",
  });
});

test("the expected output of a saved case is the output text, or its JSON", () => {
  assert.equal(expectedOutputOf("It is refunded."), "It is refunded.");
  assert.equal(expectedOutputOf({ ok: true }), '{\n  "ok": true\n}');
  assert.equal(expectedOutputOf(null), null);
  assert.equal(expectedOutputOf(undefined), null);
});

test("each missing or wrong setting of the server is named", () => {
  const ok = { ok: true as const, key: Buffer.alloc(32) };
  assert.deepEqual(configurationProblems({ kind: "local-docker" }, ok), []);
  assert.deepEqual(configurationProblems({ kind: "boat" }, ok), []);
  const missing = configurationProblems(
    { kind: "none" },
    { ok: false, reason: "not_configured", message: "SANDBOX_SECRETS_KEY is not configured." },
  );
  assert.deepEqual(
    missing.map((problem) => problem.setting),
    ["SANDBOX_PROVIDER", "SANDBOX_SECRETS_KEY"],
  );
  assert.equal(missing[1].message, "SANDBOX_SECRETS_KEY is not configured.");
  const refused = configurationProblems(
    { kind: "refused", reason: "SANDBOX_PROVIDER=local-docker does not run in production." },
    ok,
  );
  assert.deepEqual(refused, [
    {
      setting: "SANDBOX_PROVIDER",
      message: "SANDBOX_PROVIDER=local-docker does not run in production.",
    },
  ]);
  for (const problem of missing) assert.doesNotMatch(problem.message, /boat/i);
});
