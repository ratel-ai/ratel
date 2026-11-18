import assert from "node:assert/strict";
import { test } from "node:test";
import { type TracesSessionsRouteDeps, tracesSessionsResponse } from "./route";

/** RC-591: the Traces Sessions reads answer every member, with no flag. */

const PROJECT = "6b64f504-f84f-447a-afe4-fb84054735fb";
const ORG = "0d6c3b1e-8f0a-4b8e-9d55-2f1f0f3c7a10";

function deps(
  overrides: Partial<TracesSessionsRouteDeps> = {},
): TracesSessionsRouteDeps & { logged: Record<string, unknown>[] } {
  const logged: Record<string, unknown>[] = [];
  return {
    dbConfigured: () => true,
    getSession: async () => ({ userId: "user_1" }),
    findProject: async (projectId) =>
      projectId === PROJECT ? { projectId, organizationId: ORG } : null,
    setLogContext: (fields) => logged.push(fields),
    logged,
    ...overrides,
  };
}

test("a member reads the project's data, and the request log names the project and organization", async () => {
  const route = deps();
  const response = await tracesSessionsResponse(PROJECT, async (id) => ({ read: id }), route);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, data: { read: PROJECT } });
  assert.deepEqual(route.logged, [{ project_id: PROJECT, organization_id: ORG }]);
});

test("no database, no session or a project the caller cannot see answers before the read", async () => {
  let reads = 0;
  const read = async () => ++reads;
  assert.equal(
    (await tracesSessionsResponse(PROJECT, read, deps({ dbConfigured: () => false }))).status,
    404,
  );
  assert.equal(
    (await tracesSessionsResponse(PROJECT, read, deps({ getSession: async () => null }))).status,
    401,
  );
  assert.equal((await tracesSessionsResponse("other-project", read, deps())).status, 404);
  assert.equal(reads, 0);
});
