import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { setModelCallSink } from "@/lib/platform/model-call";
import { withProviders } from "@/lib/readings/models";
import { explainTextSetup } from "@/lib/readings/models/explain";
import { fakeTextModel } from "@/lib/readings/models/fake";
import { ModelHttpError } from "@/lib/readings/models/providers/http";
import {
  canCheckModels,
  checkModels,
  checkModelsAtMostEvery,
  loadModelSettings,
  MODEL_CHECK_EVERY_MS,
  resetModelCheck,
} from "./models";

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

/** A text vendor that records which feature and model each call was made as. */
function recordingVendor() {
  const calls: Array<{ feature: string; model: string }> = [];
  const restore = withProviders({
    litellm: {
      text: (context) => ({
        provider: "litellm",
        model: context.model,
        complete: async () => {
          calls.push({ feature: context.feature, model: context.model });
          return {
            text: "OK",
            usage: { inputTokens: 1, outputTokens: 1 },
            model: context.model,
            stop: "end",
          };
        },
      }),
    },
  });
  return { calls, restore };
}

const GATEWAY = {
  MODEL_PROVIDER: "litellm",
  MODEL_BASE_URL: "http://gateway.test",
  MODEL: "small",
  MODEL_FEATURE_WORKFLOW_LABEL: "labeller",
};

test("the check runs on a feature's model but is counted as the check, not as that feature", async () => {
  const { calls, restore } = recordingVendor();
  try {
    const results = await checkModels({ config: cfg(GATEWAY), environment: "production" });
    assert.equal(results.find((result) => result.kind === "text")?.ok, true);
    assert.deepEqual(calls, [{ feature: "model_check", model: "labeller" }]);
  } finally {
    restore();
  }
});

test("the check is not a feature of the page, and has no model setting of its own", () => {
  const setup = explainTextSetup(cfg(GATEWAY), "production");
  assert.ok(setup.features.every((row) => row.feature !== "model_check"));
  assert.equal(cfg({}).modelVendor.features.model_check, undefined);
  assert.equal(cfg({ MODEL_FEATURE_MODEL_CHECK: "x" }).modelVendor.features.model_check, undefined);
});

test("the decision check is counted as the check too", async () => {
  const lines: Record<string, unknown>[] = [];
  const restoreSink = setModelCallSink({
    info: (fields) => void lines.push(fields),
    warn: (fields) => void lines.push(fields),
  });
  try {
    await checkModels({
      config: cfg({ DECISION_PROVIDER: "levanto", SAGE_API_KEY: KEY }),
      environment: "production",
      fetch: answering(500),
    });
  } finally {
    restoreSink();
  }
  assert.deepEqual(
    lines.map((line) => line.feature),
    ["model_check"],
  );
});

test("only an organization's admins may run the check", () => {
  assert.equal(canCheckModels("admin"), true);
  assert.equal(canCheckModels("member"), false);
});

test("the check runs at most once in its window: a click inside it gets the last results", async () => {
  const { calls, restore } = recordingVendor();
  resetModelCheck();
  let clock = Date.parse("2026-11-24T10:00:00Z");
  const options = { config: cfg(GATEWAY), environment: "production", now: () => clock };
  try {
    const first = await checkModelsAtMostEvery(options);
    clock += MODEL_CHECK_EVERY_MS - 1;
    const second = await checkModelsAtMostEvery(options);
    assert.equal(calls.length, 1);
    assert.deepEqual(second, first);
    clock += 1;
    await checkModelsAtMostEvery(options);
    assert.equal(calls.length, 2);
  } finally {
    restore();
    resetModelCheck();
  }
});
