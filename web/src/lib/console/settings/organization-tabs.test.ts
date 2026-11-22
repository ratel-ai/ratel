import assert from "node:assert/strict";
import { test } from "node:test";
import { organizationSettingsTabsFor } from "./organization-tabs";

const labels = (role: "admin" | "member", hasDangerPage: boolean) =>
  organizationSettingsTabsFor("acme", { role, hasDangerPage }).map((tab) => tab.label);

test("Danger zone is a tab for an admin when the edition has the page", () => {
  assert.deepEqual(labels("admin", true), ["General", "Danger zone"]);
});

test("a member sees General only, as upstream's layout passes danger: isAdmin", () => {
  assert.deepEqual(labels("member", true), ["General"]);
});

test("without the edition's page nobody gets the tab, an admin neither", () => {
  assert.deepEqual(labels("admin", false), ["General"]);
});
