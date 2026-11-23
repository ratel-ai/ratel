import assert from "node:assert/strict";
import { test } from "node:test";
import { type ConfigOverride, resolveConfig } from "@/config";
import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";

const OSS = "Ratel OSS";
const CLOUD = "Ratel";

/** The flag settings, as `config.ts` resolves them from these values. */
const settings = (override: ConfigOverride = {}) => resolveConfig({ override });

test("an experimental feature is off with nothing set", () => {
  assert.equal(experimentalFeatureEnabled("evalGate", settings(), OSS), false);
  assert.equal(experimentalFeatureEnabled("evalGate", settings(), CLOUD), false);
});

test("its own flag turns it on in either edition, and only it", () => {
  const config = settings({ flags: { evalGate: true } });
  for (const edition of [OSS, CLOUD]) {
    assert.equal(experimentalFeatureEnabled("evalGate", config, edition), true);
    assert.equal(experimentalFeatureEnabled("mcpApps", config, edition), false);
  }
});

test("experimentalFeatures turns every feature on in the open-source edition", () => {
  const config = settings({ experimentalFeatures: true });
  for (const flag of ["evalGate", "mcpApps"] as const) {
    assert.equal(experimentalFeatureEnabled(flag, config, OSS), true);
  }
  assert.equal(
    experimentalFeatureEnabled("evalGate", settings({ experimentalFeatures: false }), OSS),
    false,
  );
});

test("Cloud ignores experimentalFeatures", () => {
  assert.equal(
    experimentalFeatureEnabled("evalGate", settings({ experimentalFeatures: true }), CLOUD),
    false,
  );
  assert.equal(
    experimentalFeatureEnabled(
      "evalGate",
      settings({ experimentalFeatures: true, flags: { evalGate: true } }),
      CLOUD,
    ),
    true,
  );
});

// RP-13: an edition may supply the switches through the optional `featureFlags` port.
test("without a port, featureEnabled reads the configuration as experimentalFeatureEnabled does", async () => {
  const { featureEnabled } = await import("@/lib/platform/experimental-features");
  const subject = { projectId: "p-1" };
  for (const config of [
    settings(),
    settings({ flags: { evalGate: true } }),
    settings({ flags: { evalGate: false }, experimentalFeatures: true }),
    settings({ experimentalFeatures: true }),
  ]) {
    for (const edition of [OSS, CLOUD]) {
      assert.equal(
        await featureEnabled("evalGate", subject, { config, edition, port: undefined }),
        experimentalFeatureEnabled("evalGate", config, edition),
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
      return flag === "mcpApps";
    },
  };
  const subject = { organizationId: "org-1", projectId: "p-1", actor: "user_1" };
  const deps = { config: settings(), edition: CLOUD, port };
  assert.equal(await featureEnabled("mcpApps", subject, deps), true);
  assert.equal(await featureEnabled("evalGate", subject, deps), false);
  assert.deepEqual(asked, [
    ["mcpApps", subject],
    ["evalGate", subject],
  ]);
});

test("with a port, a value the configuration forces comes first, either way", async () => {
  const { featureEnabled } = await import("@/lib/platform/experimental-features");
  const on = { enabled: async () => true };
  const off = { enabled: async () => false };
  const subject = {};
  assert.equal(
    await featureEnabled("evalGate", subject, {
      config: settings({ flags: { evalGate: true } }),
      edition: CLOUD,
      port: off,
    }),
    true,
  );
  assert.equal(
    await featureEnabled("evalGate", subject, {
      config: settings({ flags: { evalGate: false } }),
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
    await featureEnabled("evalGate", {}, { config: settings(), edition: CLOUD, port: broken }),
    false,
  );
});
