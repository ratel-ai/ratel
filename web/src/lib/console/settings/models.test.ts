import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { withProviders } from "@/lib/readings/models";
import { fakeTextModel } from "@/lib/readings/models/fake";
import { ModelHttpError } from "@/lib/readings/models/providers/http";
import { checkModels, loadModelSettings } from "./models";

const KEY = "sk-secret-value-1234567890";
const cfg = (env: Record<string, string>) => resolveConfig({ env });

const answering = (status: number, body: unknown = {}) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

test("the settings show each kind's setup and the last failure of each feature", async () => {
  const settings = await loadModelSettings({
    config: cfg({ MODEL_PROVIDER: "bedrok" }),
    environment: "production",
    failures: async () => [
      {
        feature: "workflow_label",
        kind: "text",
        provider: "openai",
        model: "gpt-6.2-sol",
        message: "OpenAI refused the key in OPENAI_API_KEY (401).",
        status: 401,
        failures: 3,
        failedAt: new Date("2026-11-24T10:00:00Z"),
        okAt: null,
      },
    ],
  });
  assert.equal(settings.text.on, false);
  assert.match(settings.text.reason ?? "", /bedrok/);
  assert.equal(settings.decisions.on, false);
  assert.equal(settings.failures.workflow_label?.failures, 3);
  assert.equal(settings.failuresUnreadable, false);
});

test("settings still open when the failures cannot be read", async () => {
  const settings = await loadModelSettings({
    config: cfg({}),
    environment: "production",
    failures: async () => {
      throw new Error("relation does not exist");
    },
  });
  assert.equal(settings.failuresUnreadable, true);
  assert.deepEqual(settings.failures, {});
});

test("the check asks each kind once and says what happened in the same words", async () => {
  const restore = withProviders({
    openai: {
      text: (context) => ({
        provider: "openai",
        model: context.model,
        complete: async () => {
          throw new ModelHttpError(401, `OpenAI answered 401: ${KEY}`);
        },
      }),
    },
  });
  try {
    const results = await checkModels({
      config: cfg({
        MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: KEY,
        DECISION_PROVIDER: "levanto",
        SAGE_API_KEY: KEY,
      }),
      environment: "production",
      fetch: answering(401),
    });
    const by = Object.fromEntries(results.map((result) => [result.kind, result]));
    assert.equal(by.text.ok, false);
    assert.match(by.text.message, /OpenAI refused the key in OPENAI_API_KEY \(401\)/);
    assert.equal(by.decision.ok, false);
    assert.match(by.decision.message, /Levanto \(Sage\) refused the key in SAGE_API_KEY \(401\)/);
    assert.equal(by.embedding.ok, false);
    assert.match(by.embedding.message, /OpenAI refused the key in OPENAI_API_KEY \(401\)/);
    assert.ok(!JSON.stringify(results).includes(KEY));
  } finally {
    restore();
  }
});

test("a kind that works says so, and one that is off is not called", async () => {
  const restore = withProviders({
    fake: { text: () => fakeTextModel({ model: "fake-model-local", reply: () => "OK" }) },
  });
  try {
    let called = 0;
    const results = await checkModels({
      config: cfg({ MODEL_PROVIDER: "fake" }),
      environment: "test",
      fetch: (async () => {
        called += 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    const by = Object.fromEntries(results.map((result) => [result.kind, result]));
    assert.equal(by.text.ok, true);
    assert.match(by.text.message, /answered/i);
    assert.equal(by.decision.ok, null);
    assert.match(by.decision.message, /No decision model/);
    assert.equal(by.embedding.ok, null);
    assert.match(by.embedding.message, /no outbound call/i);
    assert.equal(called, 0);
  } finally {
    restore();
  }
});
