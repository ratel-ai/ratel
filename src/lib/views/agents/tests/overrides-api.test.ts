import assert from "node:assert/strict";
import { test } from "node:test";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import type { AgentOverrideChange } from "../domain/overrides";
import { type AgentOverrideApiDeps, handleAgentOverrideChange } from "../overrides-api";

/** RC-776: only an organization admin writes an agent override; a merge chain is refused. */

const PROJECT = { id: "p1", organizationId: "org-1" } as Project;
const ORGANIZATION = { id: "org-1", slug: "acme" } as Organization;

function harness(overrides: Partial<AgentOverrideApiDeps> & { role?: string } = {}) {
  const writes: AgentOverrideChange[] = [];
  const tracked: unknown[] = [];
  const deps: AgentOverrideApiDeps = {
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async () => ({
      project: PROJECT,
      organization: ORGANIZATION,
      role: overrides.role ?? "admin",
    }),
    projectEntitiesEnabled: async () => true,
    isRestricted: async () => false,
    store: () => ({
      changeOverride: async (_projectId, change) => {
        if (change.mergedInto === "merged-already")
          return { ok: false, reason: "merge_target_is_merged" };
        writes.push(change);
        return {
          ok: true,
          override: {
            agentKey: change.agentKey,
            displayName: change.displayName ?? null,
            hidden: change.hidden ?? false,
            mergedInto: change.mergedInto ?? null,
          },
        };
      },
    }),
    track: async (event) => {
      tracked.push(event);
    },
    ...overrides,
  };
  const put = (body: unknown) =>
    handleAgentOverrideChange(
      new Request("http://x/api/projects/p1/agents/overrides", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
      "p1",
      deps,
    );
  return { put, writes, tracked };
}

test("an admin renames an agent: saved and tracked", async () => {
  const { put, writes, tracked } = harness();
  const response = await put({ agentKey: "researcher", displayName: "Research agent" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    override: {
      agentKey: "researcher",
      displayName: "Research agent",
      hidden: false,
      mergedInto: null,
    },
  });
  assert.deepEqual(writes, [{ agentKey: "researcher", displayName: "Research agent" }]);
  assert.equal(tracked.length, 1);
});

test("a member who is not an admin cannot write an override", async () => {
  const { put, writes } = harness({ role: "member" });
  const response = await put({ agentKey: "researcher", hidden: true });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "not_admin");
  assert.deepEqual(writes, []);
});

test("a merge chain is rejected with a clear error", async () => {
  const { put } = harness();
  const response = await put({ agentKey: "writer", mergedInto: "merged-already" });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, "merge_target_is_merged");
  assert.match(body.message, /merged into another agent/);
});

test("signed out, not a member, flag off, a support session or a bad body write nothing", async () => {
  const cases: [Partial<AgentOverrideApiDeps>, unknown, number][] = [
    [{ getSession: async () => null }, { agentKey: "a", hidden: true }, 401],
    [{ findProjectScope: async () => null }, { agentKey: "a", hidden: true }, 404],
    [{ projectEntitiesEnabled: async () => false }, { agentKey: "a", hidden: true }, 404],
    [{ isRestricted: async () => true }, { agentKey: "a", hidden: true }, 403],
    [{}, { agentKey: "a" }, 400],
    [{}, { agentKey: "a", hidden: "yes" }, 400],
    [{}, { agentKey: "a", hidden: true, extra: 1 }, 400],
  ];
  for (const [deps, body, status] of cases) {
    const { put, writes } = harness(deps);
    assert.equal((await put(body)).status, status, JSON.stringify(body));
    assert.deepEqual(writes, []);
  }
});
