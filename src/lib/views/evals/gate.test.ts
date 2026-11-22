import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrganizationFlagDeps } from "@/lib/platform/organization-flags";
import { evalsEnabledForActor, evalsOrganizationIds } from "./gate";

const PROJECT = "11111111-1111-4111-8111-111111111111";

function recordingDeps(on: ReadonlySet<string>): { deps: OrganizationFlagDeps; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    deps: {
      isConfigured: () => true,
      readOverride: () => undefined,
      evaluate: async (key, _distinctId, options) => {
        keys.push(key);
        return on.has(options.personProperties.organization_id ?? "");
      },
    },
  };
}

function envDeps(env: Record<string, string | undefined>): OrganizationFlagDeps {
  return { flags: { env, edition: "Ratel Cloud", port: undefined } };
}

test("Evals follow FF_EVALS, per organization", async () => {
  const { deps, keys } = recordingDeps(new Set(["org_on"]));
  const ids = await evalsOrganizationIds(
    [{ id: "org_on" }, { id: "org_off" }],
    { distinctId: "user_1" },
    deps,
  );
  assert.deepEqual(ids, ["org_on"]);
  assert.deepEqual([...new Set(keys)], ["FF_EVALS"]);
});

test("a decision that throws is off", async () => {
  const deps: OrganizationFlagDeps = {
    evaluate: async () => {
      throw new Error("flag service down");
    },
  };
  assert.deepEqual(
    await evalsOrganizationIds([{ id: "org_a" }], { distinctId: "user_1" }, deps),
    [],
  );
  assert.equal(await evalsEnabledForActor(PROJECT, "user_1", undefined, deps), false);
});

test("without a flag service, FF_EVALS in the environment decides, off by default", async () => {
  assert.equal(
    await evalsEnabledForActor(PROJECT, `project:${PROJECT}`, undefined, envDeps({})),
    false,
  );
  assert.equal(
    await evalsEnabledForActor(
      PROJECT,
      `project:${PROJECT}`,
      undefined,
      envDeps({ FF_EVALS: "true" }),
    ),
    true,
  );
  assert.deepEqual(
    await evalsOrganizationIds(
      [{ id: "org_a" }],
      { distinctId: "user_1" },
      envDeps({ FF_EVALS: "1" }),
    ),
    ["org_a"],
  );
});
