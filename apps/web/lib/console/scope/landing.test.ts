import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLastProjectId, signedInLandingDestination } from "@/lib/console/scope/landing";

const PROJECT_ID = "a7654cd9-a761-4bb1-8606-cb107e4c8d22";
const DB_PROJECT_ID = "b7654cd9-a761-4bb1-8606-cb107e4c8d22";
const USER_ID = "11111111-1111-4111-8111-111111111111";

test("last-project resolution prefers an accessible cookie project", async () => {
  assert.equal(
    await resolveLastProjectId(USER_ID, PROJECT_ID, {
      getLastProjectId: async () => {
        assert.fail("DB pointer must not be read after a valid cookie");
      },
      resolveProjectScope: async (projectId, userId) =>
        projectId === PROJECT_ID && userId === USER_ID ? { projectId } : null,
    }),
    PROJECT_ID,
  );
});

test("a stale or foreign cookie falls through to an accessible DB project", async () => {
  assert.equal(
    await resolveLastProjectId(USER_ID, PROJECT_ID, {
      getLastProjectId: async () => DB_PROJECT_ID,
      resolveProjectScope: async (projectId) =>
        projectId === DB_PROJECT_ID ? { projectId } : null,
    }),
    DB_PROJECT_ID,
  );
});

test("landing resumes the validated last project home", async () => {
  assert.equal(
    await signedInLandingDestination(PROJECT_ID, USER_ID, {
      getLastProjectId: async () => DB_PROJECT_ID,
      resolveProjectScope: async (projectId) =>
        projectId === DB_PROJECT_ID ? { projectId } : null,
    }),
    `/project/${DB_PROJECT_ID}`,
  );
});

test("landing falls back to organizations for an inaccessible DB pointer", async () => {
  const deps = {
    getLastProjectId: async () => DB_PROJECT_ID,
    resolveProjectScope: async () => null,
  };

  assert.deepEqual(
    await Promise.all([
      signedInLandingDestination(undefined, USER_ID, deps),
      signedInLandingDestination("not-a-project", USER_ID, deps),
    ]),
    ["/organizations", "/organizations"],
  );
});
