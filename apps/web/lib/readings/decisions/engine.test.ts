import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configured,
  decisionEngineConfigured,
  preferredDecisionEngine,
  resolveDecisionEngine,
  usdPerInputToken,
} from "./engine";
import { OPENAI_DEFAULT_BASE_URL, OPENAI_USD_PER_INPUT_TOKEN } from "./openai";

test("openai is the only engine and resolves from its key", () => {
  assert.equal(preferredDecisionEngine({}), "openai");
  assert.deepEqual(resolveDecisionEngine({ OPENAI_API_KEY: "sk-1" }), {
    name: "openai",
    apiKey: "sk-1",
    baseUrl: OPENAI_DEFAULT_BASE_URL,
  });
  assert.equal(decisionEngineConfigured({ OPENAI_API_KEY: "sk-1" }), true);
});

test("without a key no engine runs", () => {
  assert.equal(resolveDecisionEngine({}), null);
  assert.equal(decisionEngineConfigured({}), false);
});

test("a placeholder seed is not a key", () => {
  assert.equal(configured(" REPLACE_ME "), undefined);
  assert.equal(configured("  "), undefined);
  assert.equal(configured(" sk-1 "), "sk-1");
  assert.equal(resolveDecisionEngine({ OPENAI_API_KEY: "REPLACE_ME" }), null);
});

test("another engine name is ignored in this edition", () => {
  assert.equal(preferredDecisionEngine({ DECISION_ENGINE: "other" }), "openai");
  assert.equal(
    resolveDecisionEngine({ DECISION_ENGINE: "other", OPENAI_API_KEY: "sk-1" })?.name,
    "openai",
  );
});

test("a private gateway overrides the base url", () => {
  assert.equal(
    resolveDecisionEngine({ OPENAI_API_KEY: "sk-1", OPENAI_BASE_URL: "https://gw.example/v1" })
      ?.baseUrl,
    "https://gw.example/v1",
  );
});

test("the token budget prices at the engine's list price", () => {
  assert.equal(usdPerInputToken("openai"), OPENAI_USD_PER_INPUT_TOKEN);
});
