import assert from "node:assert/strict";
import { test } from "node:test";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { type McpPageDeps, resolveMcpPageContext } from "./context";

/** The MCP servers pages' context (RP-138: no switch since FF_AGENTS_PAGES is gone, ratel-cloud #529). */

const PROJECT = { id: "p1", organizationId: "org-1" } as Project;
const ORGANIZATION = { id: "org-1", slug: "acme" } as Organization;

function deps(): McpPageDeps {
  return {
    getSessionContext: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    getProjectScope: async () => ({ project: PROJECT, organization: ORGANIZATION }),
  };
}

test("the context has the window, the environment and the links' query", async () => {
  const context = await resolveMcpPageContext(
    "p1",
    { range: "7d", facetEnvironment: " prod " },
    deps(),
  );
  assert.equal(context.project, PROJECT);
  assert.equal(context.environment, "prod");
  assert.equal(context.window.environment, "prod");
  assert.ok(context.window.since < context.window.until);
  assert.deepEqual(context.query, { range: "7d", environment: "prod" });
});
