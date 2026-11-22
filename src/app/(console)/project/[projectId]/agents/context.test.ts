import assert from "node:assert/strict";
import { test } from "node:test";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { type AgentsPageDeps, resolveAgentsPageContext } from "./context";

/** The Agents pages' context (RP-138: no switch since FF_AGENTS_PAGES is gone, ratel-cloud #529). */

const PROJECT = { id: "p1", organizationId: "org-1" } as Project;
const ORGANIZATION = { id: "org-1", slug: "acme" } as Organization;

function deps(): AgentsPageDeps {
  return {
    getSessionContext: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    getProjectScope: async () => ({ project: PROJECT, organization: ORGANIZATION, role: "member" }),
  };
}

test("the context has the window, the environment and the links' query", async () => {
  const context = await resolveAgentsPageContext(
    "p1",
    { range: "7d", facetEnvironment: " prod " },
    deps(),
  );
  assert.equal(context.project, PROJECT);
  assert.equal(context.environment, "prod");
  assert.equal(context.window.environment, "prod");
  assert.ok(context.window.since < context.window.until);
  assert.deepEqual(context.query, { range: "7d", environment: "prod" });
  assert.equal(context.canEdit, false, "a member reads, an admin edits (RC-776)");
  assert.equal(context.showHidden, false);
});
