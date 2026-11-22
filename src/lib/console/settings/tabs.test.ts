import assert from "node:assert/strict";
import { test } from "node:test";
import {
  organizationSettingsRoot,
  organizationSettingsTabs,
  projectSettingsRoot,
  projectSettingsTabs,
  withQuery,
} from "@/lib/console/settings/tabs";

test("project settings tabs are URLs, with General matching its path exactly", () => {
  const tabs = projectSettingsTabs("p 1");
  assert.deepEqual(
    tabs.map((tab) => [tab.label, tab.href, tab.exact ?? false]),
    [
      ["General", "/project/p%201/settings", true],
      ["API keys", "/project/p%201/settings/api-keys", false],
      ["Developer", "/project/p%201/settings/developer", false],
      ["Danger zone", "/project/p%201/settings/danger", false],
    ],
  );
  assert.equal(projectSettingsRoot("p 1"), "/project/p%201/settings");
});

test("project settings show Pivots after API keys only with cloud-pivots on (RC-881)", () => {
  assert.deepEqual(
    projectSettingsTabs("p1", { pivots: true }).map((tab) => [tab.label, tab.href]),
    [
      ["General", "/project/p1/settings"],
      ["API keys", "/project/p1/settings/api-keys"],
      ["Pivots", "/project/p1/settings/pivots"],
      ["Developer", "/project/p1/settings/developer"],
      ["Danger zone", "/project/p1/settings/danger"],
    ],
  );
  assert.equal(
    projectSettingsTabs("p1", { pivots: false }).some((tab) => tab.label === "Pivots"),
    false,
  );
});

test("the Repository tab shows only when code handoff is on", () => {
  assert.equal(
    projectSettingsTabs("p1", { repository: false }).some((tab) => tab.label === "Repository"),
    false,
  );
  assert.deepEqual(
    projectSettingsTabs("p1", { repository: true }).map((tab) => tab.label),
    ["General", "API keys", "Developer", "Repository", "Danger zone"],
  );
  assert.equal(
    projectSettingsTabs("p1", { repository: true })[3].href,
    "/project/p1/settings/repository",
  );
});

test("organization settings show Danger zone only to the admins who can use it", () => {
  assert.deepEqual(
    organizationSettingsTabs("acme", { danger: true }).map((tab) => [tab.label, tab.href]),
    [
      ["General", "/org/acme/settings"],
      ["Danger zone", "/org/acme/settings/danger"],
    ],
  );
  assert.deepEqual(
    organizationSettingsTabs("acme", { danger: false }).map((tab) => tab.label),
    ["General"],
  );
  assert.equal(organizationSettingsRoot("a b"), "/org/a%20b/settings");
});

test("a moved page keeps every query value, repeated keys included", () => {
  assert.equal(withQuery("/x", {}), "/x");
  assert.equal(withQuery("/x", { a: undefined }), "/x");
  assert.equal(withQuery("/x", { tab: "dropped", range: "30d" }), "/x?tab=dropped&range=30d");
  assert.equal(
    withQuery("/x", { type: ["search", "invoke_end"] }),
    "/x?type=search&type=invoke_end",
  );
  assert.equal(withQuery("/x", { event: "evt/1 2" }), "/x?event=evt%2F1+2");
});
