import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptsTemperature,
  type ModelCatalog,
  parseRunSettings,
  type ResolvedRunSettings,
  RUN_SETTING_KEYS,
  type RunSettings,
  resolveRunSettings,
  runSettingsSummary,
} from "../domain/run-settings";

const DEFAULTS: ResolvedRunSettings = {
  agentModel: null,
  temperature: null,
  maxTokens: 4096,
  maxSteps: 8,
  budgetUsd: 1,
  toolModel: "claude-haiku-5-5",
  judgeModel: "claude-haiku-5-5",
};
const EVAL: Required<RunSettings> = {
  agentModel: "claude-sonnet-4-6",
  temperature: 0.7,
  maxTokens: 2000,
  maxSteps: 3,
  budgetUsd: 0.5,
  toolModel: "claude-haiku-4-5",
  judgeModel: "claude-sonnet-5-5",
};
const SUITE: Required<RunSettings> = {
  agentModel: "claude-opus-4-8",
  temperature: 0.2,
  maxTokens: 1000,
  maxSteps: 5,
  budgetUsd: 2,
  toolModel: "claude-sonnet-4-6",
  judgeModel: "claude-opus-5-5",
};
const CATALOG: ModelCatalog = {
  served: [
    "claude-opus-5-5",
    "claude-opus-4-8",
    "claude-sonnet-5-5",
    "claude-sonnet-4-6",
    "claude-haiku-5-5",
    "claude-haiku-4-5",
  ],
  notEnabled: new Set(["claude-opus-4-8"]),
};

for (const key of RUN_SETTING_KEYS) {
  test(`RC-653: ${key} comes from the eval, then the suite default, then today's default`, () => {
    const fromEval = resolveRunSettings({ [key]: EVAL[key] }, { [key]: SUITE[key] }, DEFAULTS);
    assert.equal(fromEval[key], EVAL[key]);
    assert.equal(fromEval.sources[key], "eval");
    const fromSuite = resolveRunSettings({}, { [key]: SUITE[key] }, DEFAULTS);
    assert.equal(fromSuite[key], SUITE[key]);
    assert.equal(fromSuite.sources[key], "suite");
    const fromDefault = resolveRunSettings(null, null, DEFAULTS);
    assert.equal(fromDefault[key], DEFAULTS[key]);
    assert.equal(fromDefault.sources[key], "default");
  });
}

test("RC-653: each setting resolves on its own: an eval that sets one keeps the suite's others", () => {
  const used = resolveRunSettings({ temperature: 0.3 }, { maxSteps: 4 }, DEFAULTS);
  assert.deepEqual(
    { ...used, sources: undefined },
    { ...DEFAULTS, temperature: 0.3, maxSteps: 4, sources: undefined },
  );
  assert.equal(used.sources.agentModel, "default");
});

test("RC-653: no settings anywhere gives today's defaults exactly", () => {
  const { sources, ...values } = resolveRunSettings(undefined, undefined, DEFAULTS);
  assert.deepEqual(values, DEFAULTS);
  assert.ok(Object.values(sources).every((source) => source === "default"));
});

test("RC-653: valid settings parse, and an empty object clears them", () => {
  assert.deepEqual(
    parseRunSettings({ agentModel: "claude-sonnet-4-6", temperature: 0.5, maxSteps: 3 }, CATALOG),
    { ok: true, value: { agentModel: "claude-sonnet-4-6", temperature: 0.5, maxSteps: 3 } },
  );
  assert.deepEqual(parseRunSettings({}, CATALOG), { ok: true, value: {} });
  assert.deepEqual(
    parseRunSettings({ agentModel: null, temperature: null }, CATALOG),
    { ok: true, value: {} },
    "null clears a setting",
  );
});

test("RC-653: a model the backend does not serve is refused with its name and the served list", () => {
  const parsed = parseRunSettings({ agentModel: "gpt-5" }, CATALOG);
  assert.equal(parsed.ok, false);
  assert.match(
    !parsed.ok ? parsed.error : "",
    /gpt-5 is not a Claude model that this backend serves/,
  );
  assert.match(!parsed.ok ? parsed.error : "", /claude-sonnet-5-5/);
  assert.equal(parseRunSettings({ judgeModel: "claude-2" }, CATALOG).ok, false);
  assert.equal(parseRunSettings({ toolModel: "" }, CATALOG).ok, false);
});

test("RC-653: a model that Bedrock has not enabled is refused with model_not_enabled", () => {
  const parsed = parseRunSettings({ toolModel: "claude-opus-4-8" }, CATALOG);
  assert.deepEqual(parsed, {
    ok: false,
    error: "claude-opus-4-8 is not enabled on Bedrock (model_not_enabled). Choose another model.",
    reason: "model_not_enabled",
  });
});

test("RC-653: limits out of range are refused", () => {
  for (const bad of [
    { temperature: -0.1 },
    { temperature: 1.1 },
    { maxTokens: 0 },
    { maxTokens: 1.5 },
    { maxTokens: 64_001 },
    { maxSteps: 0 },
    { maxSteps: 51 },
    { budgetUsd: 0 },
    { budgetUsd: 10.01 },
    { temperature: "hot" },
  ]) {
    assert.equal(parseRunSettings(bad, CATALOG).ok, false, JSON.stringify(bad));
  }
  assert.equal(parseRunSettings({ unknown: 1 }, CATALOG).ok, false);
  assert.equal(parseRunSettings("nope", CATALOG).ok, false);
});

test("RC-653: a temperature with an agent model that refuses sampling is refused", () => {
  const parsed = parseRunSettings({ agentModel: "claude-opus-5-5", temperature: 0.5 }, CATALOG);
  assert.equal(parsed.ok, false);
  assert.match(!parsed.ok ? parsed.error : "", /claude-opus-5-5 does not take a temperature/);
  assert.equal(
    parseRunSettings({ agentModel: "claude-opus-5-5", temperature: 0.5 }, CATALOG, {
      agentModel: "claude-sonnet-4-6",
    }).ok,
    false,
    "the eval's own model wins",
  );
  assert.equal(
    parseRunSettings({ temperature: 0.5 }, CATALOG, { agentModel: "claude-opus-5-5" }).ok,
    false,
    "the suite's model counts when the eval sets none",
  );
  assert.equal(
    parseRunSettings({ temperature: 0.5 }, CATALOG, { agentModel: "claude-sonnet-4-6" }).ok,
    true,
  );
});

test("RC-653: the 4.x models take a temperature, the 5.x models do not", () => {
  assert.equal(acceptsTemperature("claude-sonnet-4-6"), true);
  assert.equal(acceptsTemperature("claude-haiku-4-5-20251001"), true);
  assert.equal(acceptsTemperature("claude-opus-5-5"), false);
  assert.equal(acceptsTemperature("claude-fable-5-2"), false);
});

test("RC-653: the replay header lists each setting a result used and where it came from", () => {
  const summary = runSettingsSummary(
    resolveRunSettings(
      { agentModel: "claude-sonnet-4-6", temperature: 0.4 },
      { maxSteps: 3 },
      DEFAULTS,
    ),
  );
  assert.deepEqual(
    summary.map(({ label, value, source }) => [label, value, source]),
    [
      ["Agent model", "claude-sonnet-4-6", "eval"],
      ["Temperature", "0.4", "eval"],
      ["Max tokens", "4,096", "default"],
      ["Step limit", "3", "suite"],
      ["Cost budget", "$1", "default"],
      ["Tool answer model", "claude-haiku-5-5", "default"],
      ["Judge model", "claude-haiku-5-5", "default"],
    ],
  );
  assert.equal(
    runSettingsSummary(resolveRunSettings({ budgetUsd: 0.25 }, null, DEFAULTS))[4]!.value,
    "$0.25",
  );
  assert.equal(
    runSettingsSummary(resolveRunSettings(null, null, DEFAULTS))[0]!.value,
    "Recorded model",
  );
});
