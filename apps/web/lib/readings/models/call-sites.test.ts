import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelStop, TextModel, TextRequest } from "@/lib/contracts/models";
import { NAMES_KEYS_SCHEMA, NAMES_SCHEMA } from "@/lib/readings/intent-engine/names";
import {
  defaultNameDeps,
  NamesCutOffError,
  NamesDeclinedError,
  namesCompleteOver,
} from "@/lib/readings/intent-engine/names-job";
import { topicNamerOver } from "@/lib/readings/topics/job";
import { LABEL_SCHEMA } from "@/lib/readings/trace-signals/workflows/label";
import { labelCompleteOver } from "@/lib/readings/trace-signals/workflows/label-job";
import { ANALYST_SCHEMA } from "@/lib/synthesis/match-quality/analyst";
import { draftModelAvailable, draftModelFromEnv } from "@/lib/views/fix-drafts/model";
import { resetJsonModes } from "./providers/openai-compatible";

/**
 * The features that moved onto the kit (ADR-0033), on a model that is not Claude: what each
 * asks for, and that a stop keeps the feature's own error. Their golden tests hold the Claude
 * path to what it sent before.
 */

/** A text model that records what it was asked and answers as told. */
function recording(text: string, stop: ModelStop = "end") {
  const asked: TextRequest[] = [];
  const model: TextModel = {
    provider: "openai-compatible",
    model: "llama-3.3-70b",
    async complete(request) {
      asked.push(request);
      return { text, usage: { inputTokens: 10, outputTokens: 5 }, model: "llama-3.3-70b", stop };
    },
  };
  return { model, asked };
}

const OTHER = {
  MODEL_PROVIDER: "openai-compatible",
  MODEL_BASE_URL: "http://llm.test/v1",
  MODEL_STANDARD: "llama-3.3-70b",
};

test("a workflow label asks for the label schema, and a refusal throws", async () => {
  const { model, asked } = recording('{"label":"Refund a charge"}');
  assert.equal(await labelCompleteOver(model)("system", "user"), '{"label":"Refund a charge"}');
  assert.deepEqual(asked, [
    { system: "system", user: "user", schema: LABEL_SCHEMA, maxTokens: 400 },
  ]);
  await assert.rejects(
    labelCompleteOver(recording("", "refused").model)("s", "u"),
    /declined by the model's safety filter/,
  );
});

test("intent names ask for their schema at low effort, and keep their own errors", async () => {
  const { model, asked } = recording('{"names":[]}');
  const complete = namesCompleteOver(model);
  await complete("system", "user", false);
  await complete("system", "user", true);
  assert.equal(asked[0].schema, NAMES_SCHEMA);
  assert.equal(asked[1].schema, NAMES_KEYS_SCHEMA);
  assert.equal(asked[0].effort, "low");
  assert.ok((asked[0].timeoutMs ?? 0) > 0);
  assert.equal(typeof asked[0].maxRetries, "number");
  await assert.rejects(
    namesCompleteOver(recording("", "refused").model)("s", "u", false),
    NamesDeclinedError,
  );
  await assert.rejects(
    namesCompleteOver(recording("half", "cut_off").model)("s", "u", false),
    NamesCutOffError,
  );
});

test("topic names keep their own errors for a refusal and a cut-off", async () => {
  await assert.rejects(topicNamerOver(recording("", "refused").model)([]), /declined/);
  await assert.rejects(topicNamerOver(recording("half", "cut_off").model)([]), /cut off/);
});

test("the names job takes the deployment's model, whoever serves it", () => {
  const other = defaultNameDeps(OTHER);
  assert.equal(other.model, "llama-3.3-70b");
  assert.ok(other.complete);

  const fake = defaultNameDeps({ MODEL_PROVIDER: "fake" });
  assert.equal(fake.model, "fake-model-local");
  assert.ok(fake.complete);

  // A provider named without a model for the tier is no model, not Claude.
  const unnamed = defaultNameDeps({
    MODEL_PROVIDER: "openai-compatible",
    MODEL_BASE_URL: "http://llm.test/v1",
    ANTHROPIC_API_KEY: "sk-test",
  });
  assert.equal(unnamed.complete, null);
});

test("a fix draft runs on another provider, end to end", async () => {
  resetJsonModes();
  assert.equal(draftModelAvailable(OTHER, "production"), true);
  assert.equal(draftModelAvailable({ ...OTHER, MODEL_STANDARD: undefined }, "production"), false);

  const draft = draftModelFromEnv(OTHER, "production");
  assert.equal(draft?.model, "llama-3.3-70b");

  const realFetch = globalThis.fetch;
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        model: "llama-3.3-70b",
        choices: [
          { message: { role: "assistant", content: '{"proposals":[]}' }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 9 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    // Built while the stub is in place: the adapter takes `fetch` when it is made.
    const live = draftModelFromEnv(OTHER, "production");
    const reply = await live?.complete({
      system: "Draft a fix.",
      user: "The finding.",
      maxTokens: 1024,
    });
    assert.deepEqual(reply, {
      text: '{"proposals":[]}',
      usage: { inputTokens: 50, outputTokens: 9 },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "http://llm.test/v1/chat/completions");
  assert.equal(sent[0].body.model, "llama-3.3-70b");
  assert.equal(sent[0].body.max_tokens, 1024);
  assert.deepEqual(sent[0].body.response_format, {
    type: "json_schema",
    json_schema: { name: "answer", schema: ANALYST_SCHEMA, strict: false },
  });
});
