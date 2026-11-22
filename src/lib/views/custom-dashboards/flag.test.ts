import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_FLAGS, type CoreFlag, type FlagSubject } from "@/lib/contracts/feature-flags";
import {
  CUSTOM_DASHBOARDS_FLAG,
  customDashboardsEnabledFor,
  customDashboardsEnabledForActor,
} from "@/lib/views/custom-dashboards/flag";

const oss = (env: Record<string, string>) => ({ env, edition: "Ratel OSS", port: undefined });

/** A Cloud flags port that answers `answer` and records what it was asked. */
function cloud(answer: boolean | Error, env: Record<string, string> = {}) {
  const asked: [CoreFlag, FlagSubject][] = [];
  const port = {
    async enabled(flag: CoreFlag, subject: FlagSubject) {
      asked.push([flag, subject]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { asked, deps: { env, edition: "Ratel Cloud", port } };
}

test("FF_CUSTOM_DASHBOARDS is a core switch, so an edition's flags port can decide it", () => {
  assert.equal(CUSTOM_DASHBOARDS_FLAG, "FF_CUSTOM_DASHBOARDS");
  assert.ok((CORE_FLAGS as readonly string[]).includes(CUSTOM_DASHBOARDS_FLAG));
});

test("OSS: off with nothing set; FF_CUSTOM_DASHBOARDS or RATEL_EXPERIMENTAL_FEATURES turns it on", async () => {
  assert.equal(await customDashboardsEnabledFor({ actor: "user_1" }, oss({})), false);
  assert.equal(
    await customDashboardsEnabledFor({ actor: "user_1" }, oss({ FF_CUSTOM_DASHBOARDS: "1" })),
    true,
  );
  assert.equal(
    await customDashboardsEnabledFor({}, oss({ RATEL_EXPERIMENTAL_FEATURES: "1" })),
    true,
  );
  assert.equal(await customDashboardsEnabledFor({}, oss({ FF_SANDBOXES: "1" })), false);
});

test("Cloud: the port decides for the person, and for an MCP caller with the project", async () => {
  const on = cloud(true);
  assert.equal(await customDashboardsEnabledFor({ actor: "user_1" }, on.deps), true);
  assert.equal(await customDashboardsEnabledForActor("p1", "project:p1", on.deps), true);
  assert.deepEqual(on.asked, [
    ["FF_CUSTOM_DASHBOARDS", { actor: "user_1" }],
    ["FF_CUSTOM_DASHBOARDS", { projectId: "p1", actor: "project:p1" }],
  ]);
  assert.equal(await customDashboardsEnabledFor({ actor: "user_1" }, cloud(false).deps), false);
});

test("Cloud: an operator's FF_CUSTOM_DASHBOARDS comes first; a failed decision is off", async () => {
  const off = cloud(false, { FF_CUSTOM_DASHBOARDS: "1" });
  assert.equal(await customDashboardsEnabledForActor("p1", "user_1", off.deps), true);
  assert.deepEqual(off.asked, []);
  assert.equal(
    await customDashboardsEnabledFor({ actor: "user_1" }, cloud(new Error("down")).deps),
    false,
  );
});
