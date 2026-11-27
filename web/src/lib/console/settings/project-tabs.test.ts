import assert from "node:assert/strict";
import { test } from "node:test";
import { type ProjectTabsDeps, projectTabs } from "@/lib/console/settings/project-tabs";
import { projectSettingsTabs } from "@/lib/console/settings/tabs";

const scope = {
  project: { id: "p" },
  organization: { id: "o" },
  user: { externalId: "u" },
} as Awaited<ReturnType<ProjectTabsDeps["findProjectScope"]>>;

const deps = (on: boolean, found = scope): ProjectTabsDeps => ({
  findProjectScope: async () => found,
  featureEnabled: async (flag, subject) => {
    assert.equal(flag, "customMonitoring");
    assert.deepEqual(subject, { projectId: "p", organizationId: "o", actor: "u" });
    return on;
  },
});

test("Notifications shows after API keys, only with the customMonitoring flag on", async () => {
  assert.deepEqual(
    (await projectTabs("p", deps(true))).map((tab) => [tab.label, tab.href]),
    [
      ["General", "/project/p/settings"],
      ["API keys", "/project/p/settings/api-keys"],
      ["Notifications", "/project/p/settings/notifications"],
      ["Developer", "/project/p/settings/developer"],
      ["Danger zone", "/project/p/settings/danger"],
    ],
  );
  assert.deepEqual(await projectTabs("p", deps(false)), projectSettingsTabs("p"));
  assert.deepEqual(await projectTabs("p", deps(true, null)), projectSettingsTabs("p"));
});
