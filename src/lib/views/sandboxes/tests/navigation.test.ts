import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxesEnabledForOrganization } from "@/lib/platform/sandboxes-flag";
import { sandboxesProjectIds } from "../navigation";

/**
 * The rail's check (RC-1102): which projects show Sandboxes. Decided per project, with its
 * organization; a failed read hides it. Owned (ADR-0030): the switch is FF_SANDBOXES.
 */

const ORGS = [{ id: "o1" }, { id: "o2" }];
const PROJECTS = [
  { id: "p1", organizationId: "o1" },
  { id: "p2", organizationId: "o1" },
  { id: "p3", organizationId: "o2" },
  { id: "p4", organizationId: "missing" },
];

test("only the projects with the switch on show Sandboxes, each decided with its organization", async () => {
  const asked: [string, unknown][] = [];
  const ids = await sandboxesProjectIds(ORGS, PROJECTS, async (projectId, organization) => {
    asked.push([projectId, organization]);
    return projectId !== "p2";
  });
  assert.deepEqual(ids, ["p1", "p3"]);
  assert.deepEqual(asked[0], ["p1", { id: "o1" }]);
  assert.ok(
    !asked.some(([projectId]) => projectId === "p4"),
    "a project with no known organization is not asked",
  );
});

test("a flag read that throws hides Sandboxes for that project only", async () => {
  const ids = await sandboxesProjectIds(ORGS, PROJECTS, async (projectId) => {
    if (projectId === "p1") throw new Error("flag service down");
    return true;
  });
  assert.deepEqual(ids, ["p2", "p3"]);
});

test("FF_SANDBOXES off: no project shows Sandboxes; on: every project with a known organization does", async () => {
  const off = await sandboxesProjectIds(ORGS, PROJECTS, (projectId, organization) =>
    sandboxesEnabledForOrganization(projectId, organization, {
      env: {},
      edition: "Ratel OSS",
      port: undefined,
    }),
  );
  assert.deepEqual(off, []);
  const on = await sandboxesProjectIds(ORGS, PROJECTS, (projectId, organization) =>
    sandboxesEnabledForOrganization(projectId, organization, {
      env: { FF_SANDBOXES: "1" },
      edition: "Ratel OSS",
      port: undefined,
    }),
  );
  assert.deepEqual(on, ["p1", "p2", "p3"]);
});
