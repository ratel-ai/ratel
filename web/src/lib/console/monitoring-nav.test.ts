import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";
import { customMonitoringOrganizationIds } from "./monitoring-nav";

const ORGANIZATIONS = [{ id: "org-1" }, { id: "org-2" }];

test("nothing configured: no organization has the pages", async () => {
  const config = resolveConfig();
  const enabled = async () => experimentalFeatureEnabled("customMonitoring", config);
  assert.deepEqual(await customMonitoringOrganizationIds(ORGANIZATIONS, enabled), []);
});

test("the flag is decided per organization", async () => {
  const enabled = async ({ id }: { id: string }) => id === "org-2";
  assert.deepEqual(await customMonitoringOrganizationIds(ORGANIZATIONS, enabled), ["org-2"]);
});

test("a failed decision hides the pages of that organization only", async () => {
  const enabled = async ({ id }: { id: string }) => {
    if (id === "org-1") throw new Error("flag service down");
    return true;
  };
  assert.deepEqual(await customMonitoringOrganizationIds(ORGANIZATIONS, enabled), ["org-2"]);
});
