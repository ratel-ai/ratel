import assert from "node:assert/strict";
import { test } from "node:test";
import type { Skill } from "@/lib/catalog/schema";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import { type JoinsOperationDeps, joinsOperations } from "./joins";

/**
 * Retrieval telemetry (`trace_event_hits.target_id`) identifies a skill by the
 * *name* the runtime asked for, not by the catalog's UUID. Joining on id
 * silently matches nothing and reports every skill as unknown, which reads like
 * a data problem rather than a bug. These tests pin the name-keyed join.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

function skill(name: string, id: string): Skill {
  return {
    id,
    projectId: PROJECT,
    name,
    description: name,
    searchableDescription: null,
    body: "body",
    tags: [],
    tools: [],
    metadata: {},
    status: "published",
    version: 1,
    endUserId: null,
    model: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  } as Skill;
}

function deps(overrides: Partial<JoinsOperationDeps> = {}): JoinsOperationDeps {
  return {
    listSkillsSearchedButNeverInvoked: async () => [
      { skillId: "deploy-service", searchAppearances: 71 },
      { skillId: "ghost-skill", searchAppearances: 4 },
    ],
    listTopSearchQueries: async () => [{ query: "deploy the service", searches: 3 }],
    listTopErroringTools: async () => [{ toolId: "http_post", errors: 2 }],
    listSearchQueriesForSkillHit: async () => ["deploy the service"],
    listSkills: async () => [skill("deploy-service", "aaaaaaaa-0000-4000-8000-000000000001")],
    ...overrides,
  };
}

function run(operationId: string, params: unknown, joinDeps = deps()) {
  return dispatchOperation(operationId, params, {
    registry: buildRegistry(joinsOperations(joinDeps)),
    auth,
  });
}

test("a never-invoked skill resolves to its catalog id by name", async () => {
  const result = await run("get_improvement_signals", {});

  assert.ok(result.ok);
  const rows = (result.data as { searchedButNeverInvoked: Array<Record<string, unknown>> })
    .searchedButNeverInvoked;

  assert.deepEqual(rows[0], {
    skillName: "deploy-service",
    skillId: "aaaaaaaa-0000-4000-8000-000000000001",
    status: "published",
    searchAppearances: 71,
  });
});

test("a searched name with no catalog entry is reported, not dropped", async () => {
  const result = await run("get_improvement_signals", {});

  assert.ok(result.ok);
  const rows = (result.data as { searchedButNeverInvoked: Array<Record<string, unknown>> })
    .searchedButNeverInvoked;
  const ghost = rows.find((row) => row.skillName === "ghost-skill");

  assert.ok(ghost, "a skill the runtime searched for but the catalog lacks is a finding");
  assert.equal(ghost.skillId, null);
});

test("queries-for-skill takes the runtime name, and a UUID is not silently accepted", async () => {
  const byName = await run("list_search_queries_for_skill", { skillName: "deploy-service" });
  assert.ok(byName.ok);
  assert.equal((byName.data as { count: number }).count, 1);

  const byUuid = await run("list_search_queries_for_skill", {
    skillId: "aaaaaaaa-0000-4000-8000-000000000001",
  });
  assert.ok(!byUuid.ok, "skillId is not a parameter; the call must fail loudly");
  assert.equal(byUuid.error, "invalid_params");
});

test("an unmatched skill name explains itself instead of returning a bare empty list", async () => {
  const result = await run(
    "list_search_queries_for_skill",
    { skillName: "nope" },
    deps({ listSearchQueriesForSkillHit: async () => [] }),
  );

  assert.ok(result.ok);
  assert.match(result.hint ?? "", /runtime's skill name/);
});
