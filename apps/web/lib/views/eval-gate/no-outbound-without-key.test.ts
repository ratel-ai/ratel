import assert from "node:assert/strict";
import { test } from "node:test";
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
    assert.deepEqual(resolveEvalModels(NO_KEYS, undefined, environment), {
      agent: null,
      tool: null,
      judge: null,
      standIn: false,
    });
  }
  assert.deepEqual(
    resolveEvalModels({ ANTHROPIC_API_KEY: "REPLACE_ME" }, undefined, "production"),
    { agent: null, tool: null, judge: null, standIn: false },
    "the placeholder key is no key",
  );
});

test("EVAL_GATE_MOCK_MODEL=1 gives the local stand-ins, and only outside production", () => {
  const mock = { ...NO_KEYS, EVAL_GATE_MOCK_MODEL: "1" };
  assert.equal(mockModelsEnabled(mock, "development"), true);
  const local = resolveEvalModels(mock, undefined, "development");
  assert.equal(local.standIn, true);
  assert.ok(local.agent && local.tool && local.judge);
  assert.equal(local.tool.standIn, true);
  assert.equal(local.judge.standIn, true);

  assert.equal(mockModelsEnabled(mock, "production"), false);
  assert.deepEqual(resolveEvalModels(mock, undefined, "production"), {
    agent: null,
    tool: null,
    judge: null,
    standIn: false,
  });
});
