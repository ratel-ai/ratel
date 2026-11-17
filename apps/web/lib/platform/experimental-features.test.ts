import assert from "node:assert/strict";
import { test } from "node:test";
import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";

const OSS = "Ratel OSS";
const CLOUD = "Ratel Cloud";

test("an experimental feature is off with nothing set", () => {
  assert.equal(experimentalFeatureEnabled("FF_SESSION_REPLAY", {}, OSS), false);
  assert.equal(experimentalFeatureEnabled("FF_SESSION_REPLAY", {}, CLOUD), false);
});

test("its own flag turns it on in either edition, and only it", () => {
  for (const edition of [OSS, CLOUD]) {
    assert.equal(experimentalFeatureEnabled("FF_EVAL_GATE", { FF_EVAL_GATE: "1" }, edition), true);
    assert.equal(
      experimentalFeatureEnabled("FF_HEALTH_SCORE", { FF_EVAL_GATE: "1" }, edition),
      false,
    );
  }
});

test("RATEL_EXPERIMENTAL_FEATURES turns every feature on in the open-source edition", () => {
  const env = { RATEL_EXPERIMENTAL_FEATURES: "true" };
  for (const flag of [
    "FF_EVAL_GATE",
    "FF_SESSION_REPLAY",
    "FF_HEALTH_SCORE",
    "FF_QUICK_FIRST_READING",
  ]) {
    assert.equal(experimentalFeatureEnabled(flag, env, OSS), true);
  }
  assert.equal(
    experimentalFeatureEnabled("FF_SESSION_REPLAY", { RATEL_EXPERIMENTAL_FEATURES: "0" }, OSS),
    false,
  );
});

test("Cloud ignores RATEL_EXPERIMENTAL_FEATURES", () => {
  const env = { RATEL_EXPERIMENTAL_FEATURES: "1" };
  assert.equal(experimentalFeatureEnabled("FF_SESSION_REPLAY", env, CLOUD), false);
  assert.equal(
    experimentalFeatureEnabled("FF_SESSION_REPLAY", { ...env, FF_SESSION_REPLAY: "1" }, CLOUD),
    true,
  );
});
