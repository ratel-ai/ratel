import assert from "node:assert/strict";
import { test } from "node:test";
import type { TextModel } from "@/lib/contracts/models";
import { fakeTextModel } from "./fake";
import { models, modelsConfigured, withProviders } from "./index";

const FAKE_ENV = { MODEL_PROVIDER: "fake" };

test("the fake provider answers a text feature in a local environment", async () => {
  const model = models.text("workflow_label", { env: FAKE_ENV, environment: "test" });
  assert.ok(model);
  assert.equal(model.provider, "fake");
  assert.equal(model.model, "fake-model-local");
  const reply = await model.complete({ system: "s", user: "u", maxTokens: 100 });
  assert.equal(reply.stop, "end");
  assert.equal(reply.model, "fake-model-local");
  assert.ok(reply.usage.inputTokens > 0);
});

test("with a schema the fake provider answers a JSON object that fits it", async () => {
  const model = models.text("eval_gate_fix_draft", { env: FAKE_ENV, environment: "test" });
  const reply = await model?.complete({
    system: "s",
    user: "u",
    maxTokens: 100,
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
        kind: { enum: ["a", "b"] },
        nested: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        optional: { type: "string" },
      },
      required: ["name", "count", "tags", "kind", "nested"],
    },
  });
  assert.deepEqual(JSON.parse(reply?.text ?? ""), {
    name: "",
    count: 0,
    tags: [],
    kind: "a",
    nested: { ok: false },
  });
});

test("the fake chat model calls the first tool, then answers once it has the result", async () => {
  const chat = models.chat("eval_gate_replay", { env: FAKE_ENV, environment: "test" });
  assert.ok(chat);
  const tools = [{ name: "lookup", description: "Look it up", parameters: { type: "object" } }];
  const first = await chat.next({
    system: "s",
    tools,
    messages: [{ role: "user", text: "find it" }],
    maxTokens: 100,
  });
  assert.deepEqual(first.calls, [{ id: "call_1", name: "lookup", args: {} }]);
  const second = await chat.next({
    system: "s",
    tools,
    messages: [
      { role: "user", text: "find it" },
      { role: "assistant", text: first.text, calls: first.calls, raw: first.raw },
      { role: "tool", callId: "call_1", content: "found", isError: false },
    ],
    maxTokens: 100,
  });
  assert.deepEqual(second.calls, []);
  assert.equal(second.stop, "end");
  assert.match(second.text, /found/);
});

test("no provider, no model: nothing is built in production without a setting", () => {
  assert.equal(models.text("workflow_label", { env: {}, environment: "production" }), null);
  assert.equal(models.chat("eval_gate_replay", { env: {}, environment: "production" }), null);
  assert.equal(models.text("workflow_label", { env: FAKE_ENV, environment: "production" }), null);
  assert.equal(modelsConfigured({ env: {}, environment: "production" }), false);
  assert.equal(modelsConfigured({ env: FAKE_ENV, environment: "test" }), true);
});

test("a feature is asked for by its own kind", () => {
  assert.throws(
    () => models.text("eval_gate_replay" as never, { env: FAKE_ENV, environment: "test" }),
    /eval_gate_replay is a chat feature/,
  );
  assert.throws(
    () => models.chat("workflow_label" as never, { env: FAKE_ENV, environment: "test" }),
    /workflow_label is a text feature/,
  );
});

test("a provider without a model for the feature's tier gives no model", () => {
  const seen: string[] = [];
  const restore = withProviders({
    custom: {
      text(context) {
        seen.push(context.model);
        return fakeTextModel({ model: context.model });
      },
    },
  });
  try {
    const env = { MODEL_PROVIDER: "custom", MODEL_BASE_URL: "http://x/v1" };
    assert.equal(models.text("workflow_label", { env, environment: "production" }), null);
    const model = models.text("workflow_label", {
      env: { ...env, MODEL_STANDARD: "llama-3.3-70b" },
      environment: "production",
    });
    assert.equal(model?.model, "llama-3.3-70b");
    assert.deepEqual(seen, ["llama-3.3-70b"]);
  } finally {
    restore();
  }
});

test("the adapter is told the feature, the payer and the provider's settings", () => {
  let context: unknown;
  const restore = withProviders({
    custom: {
      text(given) {
        context = given;
        return fakeTextModel({ model: given.model });
      },
    },
  });
  try {
    const env = {
      MODEL_PROVIDER: "custom",
      MODEL_BASE_URL: "http://x/v1",
      MODEL_API_KEY: "sk-test",
      MODEL_FAST: "small",
    };
    models.text("eval_gate_judge", { env, environment: "production", payer: "customer" });
    assert.deepEqual(context, {
      model: "small",
      feature: "eval_gate_judge",
      payer: "customer",
      vendor: { name: "custom", baseUrl: "http://x/v1", apiKey: "sk-test" },
      env,
    });
  } finally {
    restore();
  }
});

test("MODEL_MAX_OUTPUT_TOKENS caps what a feature asks for", async () => {
  const asked: number[] = [];
  const recording: TextModel = {
    provider: "custom",
    model: "m",
    async complete(request) {
      asked.push(request.maxTokens);
      return { text: "", usage: { inputTokens: 0, outputTokens: 0 }, model: "m", stop: "end" };
    },
  };
  const restore = withProviders({ custom: { text: () => recording } });
  try {
    const env = {
      MODEL_PROVIDER: "custom",
      MODEL_BASE_URL: "http://x/v1",
      MODEL_STANDARD: "m",
      MODEL_MAX_OUTPUT_TOKENS: "4096",
    };
    const model = models.text("workflow_label", { env, environment: "production" });
    await model?.complete({ system: "s", user: "u", maxTokens: 64_000 });
    await model?.complete({ system: "s", user: "u", maxTokens: 400 });
    assert.deepEqual(asked, [4096, 400]);
  } finally {
    restore();
  }
});
