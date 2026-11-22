import assert from "node:assert/strict";
import { test } from "node:test";
import { type VariantsNavDeps, variantsProjectIds } from "./navigation";

/** RC-871: the Variants rail item shows only for a project with the switch on and tagged traffic. */

const organizations = [{ id: "org-1", slug: "acme" }];
const projects = [
  { id: "p-on-traffic", organizationId: "org-1" },
  { id: "p-on-quiet", organizationId: "org-1" },
  { id: "p-off", organizationId: "org-1" },
  { id: "p-orphan", organizationId: "org-2" },
];

function deps(over: Partial<VariantsNavDeps> = {}): VariantsNavDeps {
  return {
    enabled: async (projectId, organization) => {
      assert.equal(organization.id, "org-1");
      return projectId !== "p-off";
    },
    projectsWithVariantTraffic: async (ids) => ids.filter((id) => id === "p-on-traffic"),
    now: () => new Date("2026-11-18T00:00:00Z"),
    ...over,
  };
}

test("only projects with the switch on and tagged traffic show Variants", async () => {
  assert.deepEqual(await variantsProjectIds(organizations, projects, deps()), ["p-on-traffic"]);
});

test("switch off everywhere: no read, no item", async () => {
  let reads = 0;
  const result = await variantsProjectIds(
    organizations,
    projects,
    deps({
      enabled: async () => false,
      projectsWithVariantTraffic: async () => {
        reads++;
        return [];
      },
    }),
  );
  assert.deepEqual(result, []);
  assert.equal(reads, 0);
});

test("a failed switch decision or read hides the item", async () => {
  assert.deepEqual(
    await variantsProjectIds(
      organizations,
      projects,
      deps({
        enabled: async () => {
          throw new Error("flags service down");
        },
      }),
    ),
    [],
  );
  assert.deepEqual(
    await variantsProjectIds(
      organizations,
      projects,
      deps({
        projectsWithVariantTraffic: async () => {
          throw new Error("db");
        },
      }),
    ),
    [],
  );
});
