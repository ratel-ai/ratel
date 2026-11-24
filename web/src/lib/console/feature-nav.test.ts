import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";
import { featurePagesByOrganization } from "./feature-nav";
import { FEATURE_PAGES } from "./navigation";

const ORGANIZATIONS = [{ id: "org-1" }, { id: "org-2" }];

test("nothing configured: no organization has a feature page", async () => {
  const config = resolveConfig();
  assert.deepEqual(
    await featurePagesByOrganization(ORGANIZATIONS, async (flag) =>
      experimentalFeatureEnabled(flag, config),
    ),
    { "org-1": [], "org-2": [] },
  );
});

test("each flag turns on its own page, per organization", async () => {
  for (const page of FEATURE_PAGES) {
    assert.deepEqual(
      await featurePagesByOrganization(
        ORGANIZATIONS,
        async (flag, { id }) => flag === page && id === "org-2",
      ),
      { "org-1": [], "org-2": [page] },
    );
  }
});

test("a failed decision hides that page only", async () => {
  assert.deepEqual(
    await featurePagesByOrganization([{ id: "org-1" }], async (flag) => {
      if (flag === "alerts") throw new Error("flag service down");
      return true;
    }),
    { "org-1": ["scorers", "customDashboards"] },
  );
});
