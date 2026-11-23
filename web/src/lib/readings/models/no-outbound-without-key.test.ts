import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { FEATURES } from "./features";
import { models, modelsConfigured } from "./index";

/** The settings `env` resolves to (`web/src/config.ts`). */
const cfg = (env: Record<string, string | undefined> = {}) => resolveConfig({ env });

/**
 * ADR-0009 §4: the selection is explicit and fails closed. Every environment below must give
 * no model for every feature, and building nothing must call nothing.
 */
const NO_MODEL: ReadonlyArray<[string, Record<string, string>, string]> = [
  ["nothing set", {}, "production"],
  ["placeholder Claude key", { ANTHROPIC_API_KEY: "REPLACE_ME" }, "production"],
  ["only the OpenAI key", { OPENAI_API_KEY: "sk-test" }, "production"],
  ["mistyped provider", { MODEL_PROVIDER: "opnai-compatible", MODEL_BASE_URL: "http://x" }, "test"],
  ["provider without a base URL", { MODEL_PROVIDER: "custom" }, "production"],
  [
    "provider with a key but no base URL",
    { MODEL_PROVIDER: "custom", MODEL_API_KEY: "sk-test" },
    "production",
  ],
  [
    "provider with a base URL but no model named",
    { MODEL_PROVIDER: "custom", MODEL_BASE_URL: "http://localhost:8000/v1" },
    "production",
  ],
  ...["openai", "mistral", "gcp", "bedrock", "ollama", "llama.cpp", "vllm", "litellm"].map(
    (name): [string, Record<string, string>, string] => [
      `${name} named, only a Claude key present`,
      { MODEL_PROVIDER: name, ANTHROPIC_API_KEY: "k", MODEL_STANDARD: "m" },
      "production",
    ],
  ),
  [
    "a hosted vendor at another address, only its own key present",
    { MODEL_PROVIDER: "mistral", MISTRAL_API_KEY: "k", MODEL_BASE_URL: "https://elsewhere.test" },
    "production",
  ],
  ["fake in production", { MODEL_PROVIDER: "fake" }, "production"],
  ["fake in staging", { MODEL_PROVIDER: "fake" }, "staging"],
  [
    "mistyped Claude backend",
    { ANTHROPIC_BACKEND: "bedrok", ANTHROPIC_API_KEY: "k" },
    "production",
  ],
  [
    "Bedrock with a bearer token",
    { ANTHROPIC_BACKEND: "bedrock", AWS_BEARER_TOKEN_BEDROCK: "token" },
    "production",
  ],
  [
    "another provider named, only a Claude key present",
    { MODEL_PROVIDER: "custom", ANTHROPIC_API_KEY: "k" },
    "production",
  ],
];

test("without a usable setting no feature gets a model, and nothing calls out", () => {
  const realFetch = globalThis.fetch;
  const calls: unknown[] = [];
  globalThis.fetch = (async (...args: unknown[]) => {
    calls.push(args[0]);
    throw new Error("outbound call in a no-model test");
  }) as typeof fetch;
  try {
    for (const [label, env, environment] of NO_MODEL) {
      for (const row of FEATURES) {
        if (row.kind === "text") {
          assert.equal(
            models.text(row.id as never, { config: cfg(env), environment }),
            null,
            `${label}: ${row.id}`,
          );
        } else if (row.kind === "chat") {
          assert.equal(
            models.chat(row.id as never, { config: cfg(env), environment }),
            null,
            `${label}: ${row.id}`,
          );
        }
      }
    }
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the fake provider never calls out", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("outbound call from the fake provider");
  }) as typeof fetch;
  try {
    const options = { config: cfg({ MODEL_PROVIDER: "fake" }), environment: "test" };
    assert.equal(modelsConfigured(options), true);
    await models
      .text("workflow_label", options)
      ?.complete({ system: "s", user: "u", maxTokens: 10 });
    await models
      .chat("eval_gate_replay", options)
      ?.next({ tools: [], messages: [{ role: "user", text: "hi" }], maxTokens: 10 });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
