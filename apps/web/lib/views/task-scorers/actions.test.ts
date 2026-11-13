import assert from "node:assert/strict";
import { test } from "node:test";
import { changeTaskScorer, type ScorerActionDeps } from "@/lib/views/task-scorers/actions";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const valid = {
  projectId: PROJECT,
  taskId: "wf_test",
  action: "save",
  scorer: { kind: "max_latency_ms", max: 1200 },
  enabled: true,
};

test("invalid scorer edits cannot write an override", async () => {
  const invalid = [
    null,
    { ...valid, projectId: "invalid" },
    { ...valid, taskId: " " },
    { ...valid, action: "delete" },
    { ...valid, enabled: "false" },
    { ...valid, scorer: { kind: "unknown", max: 1 } },
    ...[-1, NaN, Infinity, "100", null].map((max) => ({
      ...valid,
      scorer: { kind: "max_latency_ms", max },
    })),
    { ...valid, scorer: { kind: "expected_tool", tool: " " } },
    { ...valid, scorer: { kind: "max_tool_calls", max: 1.5 } },
    { ...valid, scorer: { kind: "max_self_corrections", max: 0.5 } },
  ];
  for (const input of invalid) {
    const { deps, saved } = setup();
    assert.deepEqual(await changeTaskScorer(input, deps), {
      ok: false,
      error: "The scorer settings are invalid.",
    });
    assert.equal(saved.length, 0);
  }
});

test("both save and reset require a session, project membership and the project flag", async () => {
  for (const input of [
    valid,
    { projectId: PROJECT, taskId: "wf_test", action: "reset", kind: "max_latency_ms" },
  ]) {
    for (const refusal of ["session", "membership", "flag"]) {
      const { deps, saved } = setup();
      if (refusal === "session") deps.getSession = async () => null;
      if (refusal === "membership") deps.findProjectScope = async () => null;
      if (refusal === "flag") deps.enabled = async () => false;
      const result = await changeTaskScorer(input, deps);
      assert.equal(result.ok, false, refusal);
      assert.equal(saved.length, 0, refusal);
    }
  }
});

test("a member can save each scorer and reset its override with audit events", async () => {
  const { deps, saved, events } = setup();
  deps.findProjectScope = async (projectId, userId) => {
    assert.equal(projectId, PROJECT);
    assert.equal(userId, "db_user");
    return { project: { id: PROJECT }, organization: { id: "org_test" } };
  };
  deps.enabled = async (projectId, actor) => {
    assert.equal(projectId, PROJECT);
    assert.equal(actor, "user_test");
    return true;
  };
  const scorers = [
    { kind: "ends_well" },
    { kind: "max_self_corrections", max: 0 },
    { kind: "max_latency_ms", max: 1200 },
    { kind: "max_cost_usd", max: 0.0025 },
    { kind: "expected_tool", tool: "notify" },
    { kind: "max_tool_calls", max: 10 },
  ];
  for (const scorer of scorers) {
    for (const enabled of [true, false]) {
      assert.deepEqual(
        await changeTaskScorer(
          { ...valid, scorer, enabled, source: "default", updatedBy: "spoofed" },
          deps,
        ),
        { ok: true },
      );
      assert.deepEqual(saved.at(-1), {
        projectId: PROJECT,
        taskId: "wf_test",
        scorer,
        enabled,
        source: "user",
        updatedBy: "user_test",
      });
    }
    assert.deepEqual(
      await changeTaskScorer(
        { projectId: PROJECT, taskId: "wf_test", action: "reset", kind: scorer.kind },
        deps,
      ),
      { ok: true },
    );
    assert.deepEqual(saved.at(-1), [PROJECT, "wf_test", scorer.kind]);
    assert.deepEqual(events.at(-1), {
      project_id: PROJECT,
      organization_id: "org_test",
      task_id: "wf_test",
      kind: scorer.kind,
      actor: "user_test",
      action: "reset",
    });
  }
  assert.equal(events.length, 18);
});

test("a failed write emits no success event", async () => {
  const { deps, events } = setup();
  deps.save = async () => {
    throw new Error("database unavailable");
  };
  await assert.rejects(changeTaskScorer(valid, deps), /database unavailable/);
  assert.equal(events.length, 0);
});

function setup() {
  const saved: unknown[] = [];
  const events: unknown[] = [];
  const deps: ScorerActionDeps = {
    getSession: async () => ({ user: { id: "db_user", externalId: "user_test" } }),
    findProjectScope: async () => ({ project: { id: PROJECT }, organization: { id: "org_test" } }),
    enabled: async () => true,
    save: async (input) => {
      saved.push(input);
    },
    reset: async (...input) => {
      saved.push(input);
    },
    observe: async (event) => {
      events.push(event);
    },
  };
  return { deps, saved, events };
}

test("criteria edits preserve the text and refuse empty or oversized criteria", async () => {
  const { deps, saved } = setup();
  for (const criteria of ["", " ", "x".repeat(5001), null]) {
    assert.equal(
      (await changeTaskScorer({ ...valid, scorer: { kind: "judge_criteria", criteria } }, deps)).ok,
      false,
    );
  }
  assert.equal(saved.length, 0);
  assert.deepEqual(
    await changeTaskScorer(
      { ...valid, scorer: { kind: "judge_criteria", criteria: "  Call notify.  " } },
      deps,
    ),
    { ok: true },
  );
  assert.deepEqual(saved[0], {
    projectId: PROJECT,
    taskId: "wf_test",
    scorer: { kind: "judge_criteria", criteria: "Call notify." },
    enabled: true,
    source: "user",
    updatedBy: "user_test",
  });
});
