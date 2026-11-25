import assert from "node:assert/strict";
import { test } from "node:test";
import { projectTabs } from "@/lib/console/settings/project-tabs";

test("Notifications shows after API keys", () => {
  assert.deepEqual(
    projectTabs("p").map((tab) => [tab.label, tab.href]),
    [
      ["General", "/project/p/settings"],
      ["API keys", "/project/p/settings/api-keys"],
      ["Notifications", "/project/p/settings/notifications"],
      ["Developer", "/project/p/settings/developer"],
      ["Danger zone", "/project/p/settings/danger"],
    ],
  );
});
