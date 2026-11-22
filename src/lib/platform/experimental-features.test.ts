import assert from "node:assert/strict";
import { test } from "node:test";
import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";

const OSS = "Ratel OSS";
const CLOUD = "Ratel Cloud";

test("an experimental feature is off with nothing set", () => {
  assert.equal(experimentalFeatureEnabled("FF_EVAL_GATE", {}, OSS), false);
  assert.equal(experimentalFeatureEnabled("FF_EVAL_GATE", {}, CLOUD), false);
});

test("its own flag turns it on in either edition, and only it", () => {
  for (const edition of [OSS, CLOUD]) {
    assert.equal(experimentalFeatureEnabled("FF_EVAL_GATE", { FF_EVAL_GATE: "1" }, edition), true);
    assert.equal(
      experimentalFeatureEnabled("FF_NEXT_FEATURE", { FF_EVAL_GATE: "1" }, edition),
      false,
    );
  }
});

test("RATEL_EXPERIMENTAL_FEATURES turns every feature on in the open-source edition", () => {
  const env = { RATEL_EXPERIMENTAL_FEATURES: "true" };
  // FF_NEXT_FEATURE stands for any switch a later feature adds.
  for (const flag of ["FF_EVAL_GATE", "FF_NEXT_FEATURE"]) {
    assert.equal(experimentalFeatureEnabled(flag, env, OSS), true);
  }
  assert.equal(
    experimentalFeatureEnabled("FF_EVAL_GATE", { RATEL_EXPERIMENTAL_FEATURES: "0" }, OSS),
    false,
  );
});

test("Cloud ignores RATEL_EXPERIMENTAL_FEATURES", () => {
  const env = { RATEL_EXPERIMENTAL_FEATURES: "1" };
  assert.equal(experimentalFeatureEnabled("FF_EVAL_GATE", env, CLOUD), false);
  assert.equal(
    experimentalFeatureEnabled("FF_EVAL_GATE", { ...env, FF_EVAL_GATE: "1" }, CLOUD),
    true,
  );
});

// RP-13: an edition may supply the switches through the optional `featureFlags` port.
test("without a port, featureEnabled reads the environment as experimentalFeatureEnabled does", async () => {
  const { featureEnabled } = await import("@/lib/platform/experimental-features");
  const subject = { projectId: "p-1" };
  for (const env of [
    {},
    { FF_EVAL_GATE: "1" },
    { FF_EVAL_GATE: "0", RATEL_EXPERIMENTAL_FEATURES: "1" },
    { RATEL_EXPERIMENTAL_FEATURES: "true" },
  ]) {
    for (const edition of [OSS, CLOUD]) {
      assert.equal(
        await featureEnabled("FF_EVAL_GATE", subject, { env, edition, port: undefined }),
        experimentalFeatureEnabled("FF_EVAL_GATE", env, edition),
      );
    }
  }
});

test("with a port, the edition decides each switch for whoever asks", async () => {
  const { featureEnabled } = await import("@/lib/platform/experimental-features");
  const asked: unknown[] = [];
  const port = {
    async enabled(flag: string, subject: unknown) {
      asked.push([flag, subject]);
      return flag === "FF_MCP_APPS";
    },
  };
  const subject = { organizationId: "org-1", projectId: "p-1", actor: "user_1" };
  const deps = { env: {}, edition: CLOUD, port };
  assert.equal(await featureEnabled("FF_MCP_APPS", subject, deps), true);
  assert.equal(await featureEnabled("FF_EVAL_GATE", subject, deps), false);
  assert.deepEqual(asked, [
    ["FF_MCP_APPS", subject],
    ["FF_EVAL_GATE", subject],
  ]);
});

test("with a port, the FF_* environment value comes first, either way", async () => {
  const { featureEnabled } = await import("@/lib/platform/experimental-features");
  const on = { enabled: async () => true };
  const off = { enabled: async () => false };
  const subject = {};
  assert.equal(
    await featureEnabled("FF_EVAL_GATE", subject, {
      env: { FF_EVAL_GATE: "1" },
      edition: CLOUD,
      port: off,
    }),
    true,
  );
  assert.equal(
    await featureEnabled("FF_EVAL_GATE", subject, {
      env: { FF_EVAL_GATE: "0" },
      edition: CLOUD,
      port: on,
    }),
    false,
  );
});

test("with a port, a failed read is off", async () => {
  const { featureEnabled } = await import("@/lib/platform/experimental-features");
  const broken = {
    enabled: async () => {
      throw new Error("flag service down");
    },
  };
  assert.equal(
    await featureEnabled("FF_EVAL_GATE", {}, { env: {}, edition: CLOUD, port: broken }),
    false,
  );
});
