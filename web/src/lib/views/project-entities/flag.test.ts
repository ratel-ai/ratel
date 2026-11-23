import assert from "node:assert/strict";
import { test } from "node:test";
import { type Config, resolveConfig } from "@/config";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { handleAgentOverrideChange } from "@/lib/views/agents/overrides-api";
import {
  PROJECT_ENTITIES_FLAG,
  projectEntitiesEnabled,
  projectEntitiesEnabledForActor,
} from "./flag";

const ORGANIZATION = { id: "org-1", slug: "acme" } as Organization;
const ON = resolveConfig({ override: { flags: { agentsPages: true } } });

test("the project-entities switch is the core's agentsPages", () => {
  assert.equal(PROJECT_ENTITIES_FLAG, "agentsPages");
});

test("off by default, for a person and for an MCP caller", async () => {
  assert.equal(await projectEntitiesEnabled(ORGANIZATION, resolveConfig()), false);
  assert.equal(
    await projectEntitiesEnabled(
      ORGANIZATION,
      resolveConfig({ override: { flags: { agentsPages: false } } }),
    ),
    false,
  );
  assert.equal(await projectEntitiesEnabledForActor("p1", "project:p1", resolveConfig()), false);
});

test("agentsPages turns it on for a person and for an MCP caller", async () => {
  assert.equal(await projectEntitiesEnabled(ORGANIZATION, ON), true);
  assert.equal(await projectEntitiesEnabledForActor("p1", "project:p1", ON), true);
  assert.equal(await projectEntitiesEnabledForActor("p1", "user-1", ON), true);
});

test("the override write reads agentsPages: off, it is not found and writes nothing", async () => {
  const writes: unknown[] = [];
  const put = (config: Config) =>
    handleAgentOverrideChange(
      new Request("http://x/api/projects/p1/agents/overrides", {
        method: "PUT",
        body: JSON.stringify({ agentKey: "researcher", hidden: true }),
      }),
      "p1",
      {
        getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
        findProjectScope: async () => ({
          project: { id: "p1", organizationId: "org-1" } as Project,
          organization: ORGANIZATION,
          role: "admin",
        }),
        projectEntitiesEnabled: (organization) => projectEntitiesEnabled(organization, config),
        isRestricted: async () => false,
        store: () => ({
          changeOverride: async (_projectId, change) => {
            writes.push(change);
            return {
              ok: true,
              override: {
                agentKey: change.agentKey,
                displayName: null,
                hidden: true,
                mergedInto: null,
              },
            };
          },
        }),
        track: async () => {},
      },
    );
  assert.equal((await put(resolveConfig())).status, 404);
  assert.deepEqual(writes, []);
  assert.equal((await put(ON)).status, 200);
  assert.equal(writes.length, 1);
});
