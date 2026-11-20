import assert from "node:assert/strict";
import { test } from "node:test";
import { maxOutputTokens, modelIdFor, resolveModelProvider } from "./config";
import { featureRow } from "./features";

const KEY = "sk-test";

test("unset MODEL_PROVIDER is Claude exactly as ANTHROPIC_BACKEND and ANTHROPIC_API_KEY decide", () => {
  assert.equal(resolveModelProvider({}, "production"), null);
  assert.deepEqual(resolveModelProvider({ ANTHROPIC_API_KEY: KEY }, "production"), {
    name: "anthropic",
  });
  assert.deepEqual(resolveModelProvider({ ANTHROPIC_BACKEND: "bedrock" }, "production"), {
    name: "anthropic",
  });
  // What gives no Claude client today gives no provider.
  assert.equal(resolveModelProvider({ ANTHROPIC_API_KEY: "REPLACE_ME" }, "production"), null);
  assert.equal(
    resolveModelProvider({ ANTHROPIC_BACKEND: "bedrok", ANTHROPIC_API_KEY: KEY }, "production"),
    null,
  );
  assert.equal(
    resolveModelProvider(
      { ANTHROPIC_BACKEND: "bedrock", AWS_BEARER_TOKEN_BEDROCK: "token" },
      "production",
    ),
    null,
  );
});

test("MODEL_PROVIDER=anthropic is the same as unset", () => {
  assert.deepEqual(
    resolveModelProvider({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY }, "production"),
    { name: "anthropic" },
  );
  assert.equal(resolveModelProvider({ MODEL_PROVIDER: "anthropic" }, "production"), null);
});

test("the text provider is never inferred from the OpenAI key", () => {
  assert.equal(resolveModelProvider({ OPENAI_API_KEY: KEY }, "production"), null);
  assert.equal(
    resolveModelProvider({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: "http://x" }, "production"),
    null,
  );
});

test("openai-compatible needs an explicit base URL; the key is optional", () => {
  assert.equal(resolveModelProvider({ MODEL_PROVIDER: "openai-compatible" }, "production"), null);
  assert.equal(
    resolveModelProvider({ MODEL_PROVIDER: "openai-compatible", MODEL_API_KEY: KEY }, "production"),
    null,
  );
  assert.deepEqual(
    resolveModelProvider(
      { MODEL_PROVIDER: "openai-compatible", MODEL_BASE_URL: "http://localhost:8000/v1/" },
      "production",
    ),
    { name: "openai-compatible", baseUrl: "http://localhost:8000/v1" },
  );
  assert.deepEqual(
    resolveModelProvider(
      {
        MODEL_PROVIDER: " OpenAI-Compatible ",
        MODEL_BASE_URL: "https://api.openai.com/v1",
        MODEL_API_KEY: KEY,
      },
      "production",
    ),
    { name: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: KEY },
  );
  // The placeholder is no value.
  assert.equal(
    resolveModelProvider(
      { MODEL_PROVIDER: "openai-compatible", MODEL_BASE_URL: "REPLACE_ME" },
      "production",
    ),
    null,
  );
});

test("an explicit provider never falls back to Claude", () => {
  assert.equal(
    resolveModelProvider(
      { MODEL_PROVIDER: "openai-compatible", ANTHROPIC_API_KEY: KEY },
      "production",
    ),
    null,
  );
});

test("an unknown provider gives no client, whatever else is set", () => {
  for (const name of ["openai", "opena-compatible", "bedrock", "ollama"]) {
    assert.equal(
      resolveModelProvider(
        { MODEL_PROVIDER: name, ANTHROPIC_API_KEY: KEY, MODEL_BASE_URL: "http://x" },
        "production",
      ),
      null,
      name,
    );
  }
});

test("the fake provider works only in local environments", () => {
  for (const environment of ["development", "local", "test"]) {
    assert.deepEqual(resolveModelProvider({ MODEL_PROVIDER: "fake" }, environment), {
      name: "fake",
    });
  }
  for (const environment of ["production", "staging", "preview", ""]) {
    assert.equal(resolveModelProvider({ MODEL_PROVIDER: "fake" }, environment), null, environment);
  }
});

test("on Claude a feature keeps its own variables, in order, then its default", () => {
  const provider = { name: "anthropic" } as const;
  const names = featureRow("intent_names");
  assert.equal(modelIdFor(names, provider, {}), "claude-sonnet-5-5");
  assert.equal(
    modelIdFor(names, provider, { TRACE_WORKFLOW_LABEL_MODEL: "claude-haiku-5-5" }),
    "claude-haiku-5-5",
  );
  assert.equal(
    modelIdFor(names, provider, {
      TRACE_WORKFLOW_LABEL_MODEL: "claude-haiku-5-5",
      TOPICS_LABEL_MODEL: "claude-opus-5-5",
      INTENT_ENGINE_NAME_MODEL: "claude-sonnet-5",
    }),
    "claude-sonnet-5",
  );
  assert.equal(
    modelIdFor(featureRow("match_quality_analyst"), provider, {
      ANTHROPIC_MODEL: "claude-opus-5",
    }),
    "claude-opus-5",
  );
  // The tier variables are for other providers; they never move a Claude deployment.
  assert.equal(
    modelIdFor(featureRow("match_quality_analyst"), provider, { MODEL_DEEP: "gpt-5.5" }),
    "claude-opus-5-5",
  );
});

test("on another provider the tier names the model, then MODEL_STANDARD, else none", () => {
  const provider = { name: "openai-compatible", baseUrl: "http://x" } as const;
  const analyst = featureRow("match_quality_analyst");
  assert.equal(modelIdFor(analyst, provider, {}), null);
  assert.equal(modelIdFor(analyst, provider, { MODEL_STANDARD: "llama-3.3-70b" }), "llama-3.3-70b");
  assert.equal(
    modelIdFor(analyst, provider, { MODEL_STANDARD: "llama-3.3-70b", MODEL_DEEP: "qwen-big" }),
    "qwen-big",
  );
  assert.equal(
    modelIdFor(featureRow("eval_gate_judge"), provider, {
      MODEL_STANDARD: "llama-3.3-70b",
      MODEL_FAST: "llama-3.1-8b",
    }),
    "llama-3.1-8b",
  );
  // A Claude id in a feature's own variable is not sent to another provider.
  assert.equal(modelIdFor(analyst, provider, { ANTHROPIC_MODEL: "claude-opus-5-5" }), null);
});

test("the fake provider names one model", () => {
  assert.equal(modelIdFor(featureRow("workflow_label"), { name: "fake" }, {}), "fake-model-local");
});

test("MODEL_MAX_OUTPUT_TOKENS is a positive whole number or nothing", () => {
  assert.equal(maxOutputTokens({}), undefined);
  assert.equal(maxOutputTokens({ MODEL_MAX_OUTPUT_TOKENS: "8192" }), 8192);
  for (const value of ["0", "-5", "abc", "12.5", "REPLACE_ME"]) {
    assert.equal(maxOutputTokens({ MODEL_MAX_OUTPUT_TOKENS: value }), undefined, value);
  }
});
