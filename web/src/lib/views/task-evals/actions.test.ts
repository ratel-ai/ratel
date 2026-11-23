import assert from "node:assert/strict";
import { test } from "node:test";
import { changeTaskEval, type TaskEvalActionDeps } from "./actions";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const CASE = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const commands = [
  { action: "pin", caseId: CASE },
  { action: "unpin", caseId: CASE },
  { action: "exclude", caseId: CASE },
  { action: "add", runId: "trace-test" },
  { action: "refresh" },
];

test("every eval action requires a session, membership and the project flag", async () => {
  for (const command of commands) {
    for (const refusal of ["session", "membership", "flag"]) {
      const deps: TaskEvalActionDeps = {
        getSession: async () => ({ user: { id: "db-user", externalId: "user_test" } }),
        findProjectScope: async (projectId, userId) => {
          assert.equal(projectId, PROJECT);
          assert.equal(userId, "db-user");
          return { project: { id: PROJECT }, organization: { id: "org-test" } };
        },
        enabled: async (projectId, actor) => {
          assert.equal(projectId, PROJECT);
          assert.equal(actor, "user_test");
          return true;
        },
        enqueue: async () => {
          assert.fail("Unauthorized actions cannot queue jobs.");
        },
        observe: async () => {
          assert.fail("Unauthorized actions cannot emit success events.");
        },
      };
      if (refusal === "session") deps.getSession = async () => null;
      if (refusal === "membership") deps.findProjectScope = async () => null;
      if (refusal === "flag") deps.enabled = async () => false;
      assert.equal(
        (await changeTaskEval({ projectId: PROJECT, taskId: "task-a", ...command }, deps)).ok,
        false,
      );
    }
  }
});

test("invalid eval commands fail before authentication or database access", async () => {
  const deps: TaskEvalActionDeps = {
    getSession: async () => {
      assert.fail("Invalid input cannot start authentication.");
    },
    findProjectScope: async () => null,
    enabled: async () => false,
    enqueue: async () => null,
    observe: async () => undefined,
  };
  for (const input of [
    null,
    [],
    {},
    { projectId: "invalid", taskId: "task-a", action: "refresh" },
    { projectId: PROJECT, taskId: " ", action: "refresh" },
    { projectId: PROJECT, taskId: "x".repeat(501), action: "refresh" },
    { projectId: PROJECT, taskId: "task-a", action: "delete", caseId: CASE },
    { projectId: PROJECT, taskId: "task-a", action: "pin", caseId: "bad" },
    ...[" ", "x".repeat(201), null, 1].map((runId) => ({
      projectId: PROJECT,
      taskId: "task-a",
      action: "add",
      runId,
    })),
  ])
    assert.equal((await changeTaskEval(input, deps)).ok, false);
});

test("refresh returns the queued job ID so the page can follow completion", async () => {
  const result = await changeTaskEval(
    { projectId: PROJECT, taskId: "task-a", action: "refresh" },
    {
      getSession: async () => ({ user: { id: "member", externalId: "user_test" } }),
      findProjectScope: async () => ({
        project: { id: PROJECT },
        organization: { id: "org-test" },
      }),
      enabled: async () => true,
      enqueue: async () => ({ id: "refresh-job-1" }),
      observe: async () => undefined,
    },
  );
  assert.deepEqual(result, { ok: true, message: "Refreshing…", jobId: "refresh-job-1" });
});
