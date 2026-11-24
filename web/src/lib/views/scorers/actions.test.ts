import assert from "node:assert/strict";
import { test } from "node:test";
import { changeScorer, type ScorerActionDeps } from "./actions";
import { checkDraft, judgeDraft } from "./test-support";
import type { Scorer, ScorerDraft } from "./types";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SCORER = "22222222-2222-4222-8222-222222222222";
const create = (draft: unknown) => ({ projectId: PROJECT, action: "create", draft });
const changes = [
  create(checkDraft()),
  { projectId: PROJECT, action: "update", scorerId: SCORER, draft: checkDraft() },
  { projectId: PROJECT, action: "set_enabled", scorerId: SCORER, enabled: false },
  { projectId: PROJECT, action: "delete", scorerId: SCORER },
];

test("an invalid scorer is refused and nothing is written", async () => {
  const invalid = [
    null,
    { ...create(checkDraft()), projectId: "invalid" },
    { ...create(checkDraft()), action: "unknown" },
    create(null),
    create(checkDraft({ name: " " })),
    create({ ...checkDraft(), kind: "unknown" }),
    create(checkDraft({ config: { path: "duration_ms", op: "near" as never, value: 1 } })),
    create(checkDraft({ config: { path: "unknown", op: "eq", value: 1 } })),
    create(checkDraft({ config: { path: "attributes.", op: "eq", value: 1 } })),
    create(checkDraft({ config: { path: "duration_ms", op: "gt", value: "fast" } })),
    create(checkDraft({ config: { path: "duration_ms", op: "gt", value: " " } })),
    create(checkDraft({ config: { path: "service", op: "eq" } })),
    ...[0, 101, 1.5, NaN, "50"].map((sampleRate) => create({ ...checkDraft(), sampleRate })),
    create({ ...checkDraft(), enabled: "true" }),
    create({ ...checkDraft(), filter: { models: "gpt" } }),
    create({ ...checkDraft(), filter: { status: "slow" } }),
    create({ ...checkDraft(), filter: { minCostUsd: -1 } }),
    create({ ...checkDraft(), filter: { taskId: " " } }),
    ...["", " ", "x".repeat(5001)].map((prompt) =>
      create(judgeDraft({ config: { prompt, output: "boolean" } })),
    ),
    create(judgeDraft({ config: { prompt: "Good?", output: "stars" as never } })),
    { projectId: PROJECT, action: "set_enabled", scorerId: SCORER, enabled: "yes" },
    { projectId: PROJECT, action: "delete", scorerId: "x" },
  ];
  for (const input of invalid) {
    const { deps, writes } = setup();
    assert.equal((await changeScorer(input, deps)).ok, false, JSON.stringify(input));
    assert.equal(writes.length, 0);
  }
});

test("every change requires a session, project membership and the flag", async () => {
  for (const input of changes) {
    for (const refusal of ["session", "membership", "flag"]) {
      const { deps, writes } = setup();
      if (refusal === "session") deps.getSession = async () => null;
      if (refusal === "membership") deps.findProjectScope = async () => null;
      if (refusal === "flag") deps.enabled = async () => false;
      assert.equal((await changeScorer(input, deps)).ok, false, refusal);
      assert.equal(writes.length, 0, refusal);
    }
  }
});

test("a member creates, updates, switches and deletes, with one event each", async () => {
  const { deps, writes, events } = setup();
  for (const input of changes)
    assert.deepEqual(await changeScorer(input, deps), { ok: true, scorerId: SCORER });
  assert.deepEqual(writes, [
    ["create", PROJECT, checkDraft(), "user_test"],
    ["update", PROJECT, SCORER, checkDraft(), "user_test"],
    ["setEnabled", PROJECT, SCORER, false, "user_test"],
    ["remove", PROJECT, SCORER],
  ]);
  assert.deepEqual(
    events.map((event) => event.action),
    ["create", "update", "set_enabled", "delete"],
  );
});

test("unknown keys never reach the store", async () => {
  const { deps, writes } = setup();
  await changeScorer(
    create({ ...checkDraft(), projectId: "x", createdBy: "x", filter: { models: ["a"], z: 1 } }),
    deps,
  );
  assert.deepEqual(writes[0], [
    "create",
    PROJECT,
    checkDraft({ filter: { models: ["a"] } }),
    "user_test",
  ]);
});

test("a scorer keeps its kind and its answer, and a scorer of another project is not found", async () => {
  const update = (draft: ScorerDraft) => ({
    projectId: PROJECT,
    action: "update",
    scorerId: SCORER,
    draft,
  });
  const kind = setup();
  assert.equal((await changeScorer(update(judgeDraft()), kind.deps)).ok, false);
  const scale = setup(judgeDraft());
  assert.equal(
    (
      await changeScorer(
        update(judgeDraft({ config: { prompt: "Good?", output: "numeric" } })),
        scale.deps,
      )
    ).ok,
    false,
  );
  const task = setup(checkDraft({ filter: { taskId: "task-a" } }));
  for (const filter of [{}, { taskId: "task-b" }])
    assert.equal((await changeScorer(update(checkDraft({ filter })), task.deps)).ok, false);
  assert.equal(
    (
      await changeScorer(
        update(checkDraft({ filter: { taskId: "task-a" } })),
        setup(checkDraft({ filter: { taskId: "task-a" } })).deps,
      )
    ).ok,
    true,
  );
  const missing = setup();
  missing.deps.get = async () => null;
  for (const input of changes.slice(1))
    assert.deepEqual(await changeScorer(input, missing.deps), {
      ok: false,
      error: "The scorer does not exist.",
    });
  for (const { writes } of [kind, scale, task, missing]) assert.equal(writes.length, 0);
});

function setup(current: ScorerDraft = checkDraft()) {
  const writes: unknown[][] = [];
  const events: { action: string }[] = [];
  const record =
    <T>(name: string, result: T) =>
    async (...args: unknown[]) => {
      writes.push([name, ...args]);
      return result;
    };
  const deps: ScorerActionDeps = {
    getSession: async () => ({ user: { id: "db_user", externalId: "user_test" } }),
    findProjectScope: async () => ({ project: { id: PROJECT }, organization: { id: "org_test" } }),
    enabled: async () => true,
    get: async () =>
      ({
        ...current,
        id: SCORER,
        projectId: PROJECT,
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as Scorer,
    create: record("create", SCORER),
    update: record("update", true),
    setEnabled: record("setEnabled", true),
    remove: record("remove", true),
    observe: async (event) => {
      events.push(event);
    },
  };
  return { deps, writes, events };
}
