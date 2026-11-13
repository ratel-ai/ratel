import assert from "node:assert/strict";
import { test } from "node:test";
import { type DraftTestActionDeps, draftTaskTest } from "./draft-action";

const projectId = "11111111-1111-4111-8111-111111111111";
const turnId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

test("draft actions check session, membership and the project flag before a model call", async () => {
  for (const refusal of ["session", "membership", "flag"]) {
    const deps: DraftTestActionDeps = {
      getSession: async () => ({ user: { id: "member", externalId: "user_test" } }),
      findProjectScope: async () => ({ project: { id: projectId }, organization: { id: "org" } }),
      enabled: async () => true,
      draft: async () => assert.fail("Rejected requests cannot call a model."),
    };
    if (refusal === "session") deps.getSession = async () => null;
    if (refusal === "membership") deps.findProjectScope = async () => null;
    if (refusal === "flag") deps.enabled = async () => false;
    assert.equal((await draftTaskTest({ projectId, taskId: "task-a", turnId }, deps)).ok, false);
  }
});
