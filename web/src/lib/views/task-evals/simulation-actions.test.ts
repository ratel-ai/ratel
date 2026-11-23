import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyChange } from "@/lib/views/eval-gate/change";
import { changeTaskSimulation, type TaskSimulationActionDeps } from "./simulation-actions";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const commands = [
  { action: "mark-live", version: "v2", notes: "Release" },
  { action: "run" },
  { action: "draft", change: { ...emptyChange(), patches: { search: "Find an invoice." } } },
  { action: "add-test", runId: "trace-one", expected: {}, criteria: "" },
  {
    action: "edit-test",
    caseId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    expected: {},
    criteria: "",
  },
];

test("simulation actions require a session, project membership and the project flag", async () => {
  for (const command of commands) {
    for (const refusal of ["session", "membership", "flag"]) {
      const deps: TaskSimulationActionDeps = {
        getSession: async () => ({ user: { id: "member", externalId: "user_test" } }),
        findProjectScope: async (projectId, userId) => {
          assert.equal(projectId, PROJECT);
          assert.equal(userId, "member");
          return { project: { id: PROJECT }, organization: { id: "org" } };
        },
        enabled: async (projectId, actor) => {
          assert.equal(projectId, PROJECT);
          assert.equal(actor, "user_test");
          return true;
        },
        loadFix: async () => assert.fail("Denied requests cannot read a fix."),
        run: async () => assert.fail("Denied requests cannot start simulations."),
        observe: async () => assert.fail("Denied requests cannot emit success events."),
      };
      if (refusal === "session") deps.getSession = async () => null;
      if (refusal === "membership") deps.findProjectScope = async () => null;
      if (refusal === "flag") deps.enabled = async () => false;
      const result = await changeTaskSimulation(
        { projectId: PROJECT, taskId: "task-a", fixId: "rewrite:one", ...command },
        deps,
      );
      assert.equal(result.ok, false);
    }
  }
});

test("invalid simulation commands fail before authentication", async () => {
  const deps: TaskSimulationActionDeps = {
    getSession: async () => assert.fail("Invalid requests cannot authenticate."),
    findProjectScope: async () => null,
    enabled: async () => false,
    loadFix: async () => null,
    run: async () => ({ status: "queued" }),
    observe: async () => undefined,
  };
  const base = { projectId: PROJECT, taskId: "task-a", fixId: "rewrite:one" };
  for (const input of [
    null,
    [],
    {},
    { ...base, projectId: "invalid", action: "run" },
    { ...base, taskId: " ", action: "run" },
    { ...base, fixId: "x".repeat(501), action: "run" },
    { ...base, action: "delete" },
    { ...base, action: "mark-live", version: " " },
    { ...base, action: "mark-live", version: "v2", notes: 42 },
    { ...base, action: "mark-live", version: "v".repeat(201) },
    { ...base, action: "mark-live", version: "v2", notes: "n".repeat(10001) },
    { ...base, action: "draft", change: {} },
    { ...base, action: "draft", change: { ...emptyChange(), patches: { a: "x".repeat(100001) } } },
    { ...base, action: "add-test", runId: " ", expected: {}, criteria: "" },
    { ...base, action: "edit-test", caseId: "invalid", expected: {}, criteria: "" },
    ...[{ maxToolCalls: -1 }, { maxToolCalls: 1.5 }, { tool: 42 }, { unknown: true }].map(
      (expected) => ({ ...base, action: "add-test", runId: "trace-one", expected, criteria: "" }),
    ),
  ])
    assert.equal((await changeTaskSimulation(input, deps)).ok, false);
});
