import assert from "node:assert/strict";
import { test } from "node:test";
import type { Skill } from "@/lib/catalog/schema";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { Organization } from "@/lib/platform/organizations";
import { type WriteOperationDeps, writeOperations } from "./writes";

/**
 * Bulk import, which is the write with the most ways to go quietly wrong: it is
 * the only one that can partially apply, the only one whose quota is checked
 * against a batch rather than a single row, and the only one where the caller
 * supplies the key it upserts on.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

const organization = { id: "org-1", plan: "pro" } as unknown as Organization;

function skillInput(name: string) {
  return { name, description: `does ${name}`, body: "body text" };
}

function deps(overrides: Partial<WriteOperationDeps> = {}): WriteOperationDeps {
  return {
    createSkill: async () => ({ ok: true, skill: {} as Skill }),
    updateSkill: async () => ({ ok: true, skill: {} as Skill }),
    setSkillStatus: async () => ({ ok: true, skill: {} as Skill }),
    countSkills: async () => 0,
    getOrganizationByProjectId: async () => organization,
    getActiveSkillByName: async () => null,
    importSkills: async () => ({ ok: true, created: ["a"], updated: [], unchanged: [] }),
    ...overrides,
  } as WriteOperationDeps;
}

function run(params: Record<string, unknown>, overrides: Partial<WriteOperationDeps> = {}) {
  return dispatchOperation("import_skills", params, {
    registry: buildRegistry(writeOperations(deps(overrides))),
    auth,
  });
}

test("an import reports what it did to each name, and how many", async () => {
  const result = await run(
    { skills: [skillInput("alpha"), skillInput("beta")] },
    {
      importSkills: async () => ({
        ok: true,
        created: ["alpha"],
        updated: ["beta"],
        unchanged: [],
      }),
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual((result as { data: { counts: unknown } }).data.counts, {
    created: 1,
    updated: 1,
    unchanged: 0,
  });
});

/**
 * Names are the upsert key, so a repeat is ambiguous rather than redundant: the
 * second entry would overwrite the first one's create and the caller would be
 * told it created a skill whose content it never sent.
 */
test("a name repeated inside one batch is refused before anything is written", async () => {
  let imported = false;
  const result = await run(
    { skills: [skillInput("alpha"), skillInput("alpha")] },
    {
      importSkills: async () => {
        imported = true;
        return { ok: true, created: [], updated: [], unchanged: [] };
      },
    },
  );

  assert.equal(result.ok === false && result.error, "invalid_params");
  assert.equal(imported, false);
});

test("a batch that would exceed the plan limit is refused as a quota failure", async () => {
  const result = await run(
    { skills: [skillInput("alpha")] },
    {
      importSkills: async () => ({
        ok: false,
        reason: "quota_exceeded",
        limit: 10,
        message: "Your plan allows 10 skills per project.",
      }),
    },
  );

  // Not a conflict and not invalid input: the agent's move is to ask for an
  // upgrade or archive something, and only this code says that.
  assert.equal(result.ok === false && result.error, "quota_exceeded");
  assert.equal(result.ok === false && result.reason, "maxSkillsPerProject");
});

test("an empty import is rejected by the schema rather than reported as success", async () => {
  const result = await run({ skills: [] });

  assert.equal(result.ok === false && result.error, "invalid_params");
});
