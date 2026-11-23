import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { draftModelAvailable, draftModelFromEnv } from "@/lib/views/fix-drafts/model";
import { mockModelsEnabled, resolveEvalModels } from "./models";

/**
 * With no model key the eval gate has no model at all: nothing is constructed that could call
 * out. The stand-ins are a local switch, never a production one. The same guarantee on a seeded
 * database, with the network cut, is at the end of `replay.integration.test.ts`. No upstream
 * counterpart (the sibling of `readings/no-outbound-without-key.test.ts`).
 */

const NO_KEYS = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined };

test("with no key and no mock there is no agent, no tool stand-in and no judge", () => {
  for (const environment of ["production", "development", "test"]) {
    assert.deepEqual(resolveEvalModels(resolveConfig({ env: NO_KEYS }), undefined, environment), {
      agent: null,
      tool: null,
      judge: null,
      standIn: false,
    });
  }
  assert.deepEqual(
    resolveEvalModels(
      resolveConfig({ env: { ANTHROPIC_API_KEY: "REPLACE_ME" } }),
      undefined,
      "production",
    ),
    { agent: null, tool: null, judge: null, standIn: false },
    "the placeholder key is no key",
  );
});

test("EVAL_GATE_MOCK_MODEL=1 gives the local stand-ins, and only outside production", () => {
  const mock = { ...NO_KEYS, EVAL_GATE_MOCK_MODEL: "1" };
  assert.equal(mockModelsEnabled(resolveConfig({ env: mock }), "development"), true);
  const local = resolveEvalModels(resolveConfig({ env: mock }), undefined, "development");
  assert.equal(local.standIn, true);
  assert.ok(local.agent && local.tool && local.judge);
  assert.equal(local.tool.standIn, true);
  assert.equal(local.judge.standIn, true);

  assert.equal(mockModelsEnabled(resolveConfig({ env: mock }), "production"), false);
  assert.deepEqual(resolveEvalModels(resolveConfig({ env: mock }), undefined, "production"), {
    agent: null,
    tool: null,
    judge: null,
    standIn: false,
  });
});

test("with no key and no mock there is no fix-draft model, and nothing to queue a draft for", () => {
  for (const environment of ["production", "development", "test"]) {
    assert.equal(draftModelFromEnv(resolveConfig({ env: NO_KEYS }), environment), null);
    assert.equal(draftModelAvailable(resolveConfig({ env: NO_KEYS }), environment), false);
  }
  assert.equal(
    draftModelFromEnv(resolveConfig({ env: { ANTHROPIC_API_KEY: "REPLACE_ME" } }), "production"),
    null,
    "the placeholder key is no key",
  );
  const mock = { ...NO_KEYS, EVAL_GATE_MOCK_MODEL: "1" };
  assert.ok(draftModelFromEnv(resolveConfig({ env: mock }), "development"));
  assert.equal(draftModelFromEnv(resolveConfig({ env: mock }), "production"), null);
});

test("the Claude backend decides, not the key alone: Bedrock needs no key, a typo is no model", () => {
  const bedrock = { ...NO_KEYS, ANTHROPIC_BACKEND: "bedrock" };
  assert.equal(draftModelAvailable(resolveConfig({ env: bedrock }), "production"), true);
  assert.ok(draftModelFromEnv(resolveConfig({ env: bedrock }), "production"));
  assert.ok(resolveEvalModels(resolveConfig({ env: bedrock }), undefined, "production").agent);

  const typo = { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BACKEND: "bedrok" };
  assert.equal(draftModelAvailable(resolveConfig({ env: typo }), "production"), false);
  assert.equal(draftModelFromEnv(resolveConfig({ env: typo }), "production"), null);
  assert.equal(
    resolveEvalModels(resolveConfig({ env: typo }), undefined, "production").agent,
    null,
  );
});
