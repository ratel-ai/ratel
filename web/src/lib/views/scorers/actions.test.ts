import assert from "node:assert/strict";
import { test } from "node:test";
import { changeScorer, type ScorerActionDeps, testScorer } from "./actions";
import { parseScorerDraft } from "./config";
import { checkDraft, judgeDraft } from "./test-support";
import type { Scorer, ScorerDraft } from "./types";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SCORER = "22222222-2222-4222-8222-222222222222";
const create = (draft: unknown) => ({ projectId: PROJECT, action: "create", draft });
const changes = [
  create(checkDraft()),
  { projectId: PROJECT, action: "update", scorerId: SCORER, draft: checkDraft() },
  { projectId: PROJECT, action: "set_enabled", scorerId: SCORER, enabled: false },
  { projectId: PROJECT, action: "attach", scorerId: SCORER, taskId: "task-b", narrow: true },
  { projectId: PROJECT, action: "detach", scorerId: SCORER, taskId: "task-b" },
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
    create({ ...checkDraft(), tasks: [" "] }),
    create({ ...checkDraft(), tasks: "task-a" }),
    create(checkDraft({ tasks: [] })),
    create(checkDraft({ tasks: Array.from({ length: 51 }, (_, n) => `t${n}`) })),
    { projectId: PROJECT, action: "attach", scorerId: SCORER, taskId: " " },
    { projectId: PROJECT, action: "detach", scorerId: SCORER },
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

test("F445-2: a support session cannot create, change, delete or test a scorer", async () => {
  const refused = { ok: false, error: "A support session cannot change scorers." };
  for (const input of changes) {
    const { deps, writes, events } = setup();
    deps.isRestricted = async () => true;
    assert.deepEqual(await changeScorer(input, deps), refused, input.action);
    assert.deepEqual([writes, events], [[], []], input.action);
  }
  let previews = 0;
  const { deps } = setup();
  const preview = async () => {
    previews++;
    return [];
  };
  const tested = (isRestricted: boolean) =>
    testScorer(PROJECT, judgeDraft(), {
      ...deps,
      isRestricted: async () => isRestricted,
      preview,
    });
  assert.deepEqual(await tested(true), refused);
  assert.equal(previews, 0);
  assert.deepEqual(await tested(false), { ok: true, results: [] });
});

test("F445-9: a project has at most 100 scorers", async () => {
  const { deps, writes } = setup();
  deps.count = async () => 99;
  assert.equal((await changeScorer(create(checkDraft()), deps)).ok, true);
  deps.count = async () => 100;
  assert.deepEqual(await changeScorer(create(checkDraft()), deps), {
    ok: false,
    error: "This project has 100 scorers, and the limit is 100. Delete 1 to create another.",
  });
  // Over the limit (legacy excess from the task scorers' conversion): refused too, with the real count.
  deps.count = async () => 130;
  assert.deepEqual(await changeScorer(create(checkDraft()), deps), {
    ok: false,
    error: "This project has 130 scorers, and the limit is 100. Delete 31 to create another.",
  });
  assert.equal(writes.length, 1);
});

test("F445-7: a NUL character in a scorer is refused; a line break in a question is not", () => {
  const nul = "a\u0000b";
  assert.equal(parseScorerDraft(checkDraft({ name: nul })).ok, false);
  assert.equal(parseScorerDraft(checkDraft({ filter: { models: [nul] } })).ok, false);
  assert.equal(
    parseScorerDraft(checkDraft({ config: { path: "service", op: "eq", value: nul } })).ok,
    false,
  );
  const prompt = "Polite?\n\tAnd short?";
  assert.equal(parseScorerDraft(judgeDraft({ config: { prompt, output: "boolean" } })).ok, true);
});

test("a member creates, updates, switches and deletes, with one event each", async () => {
  const { deps, writes, events } = setup();
  for (const input of changes)
    assert.deepEqual(await changeScorer(input, deps), { ok: true, scorerId: SCORER });
  assert.deepEqual(writes, [
    ["create", PROJECT, checkDraft(), "user_test"],
    ["update", PROJECT, SCORER, checkDraft(), "user_test"],
    ["setEnabled", PROJECT, SCORER, false, "user_test"],
    ["attach", PROJECT, SCORER, "task-b", "user_test"],
    ["detach", PROJECT, SCORER, "task-b", "user_test"],
    ["remove", PROJECT, SCORER],
  ]);
  assert.deepEqual(
    events.map((event) => event.action),
    ["create", "update", "set_enabled", "attach", "detach", "delete"],
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
  const missing = setup();
  missing.deps.get = async () => null;
  for (const input of changes.slice(1))
    assert.deepEqual(await changeScorer(input, missing.deps), {
      ok: false,
      error: "The scorer does not exist.",
    });
  for (const { writes } of [kind, scale, missing]) assert.equal(writes.length, 0);
});

test("a scorer of every trace is narrowed to a task only when the person agreed, and 50 tasks is the most", async () => {
  const attach = (extra: object = {}) => ({
    projectId: PROJECT,
    action: "attach",
    scorerId: SCORER,
    taskId: "task-a",
    ...extra,
  });
  const every = setup();
  assert.equal((await changeScorer(attach(), every.deps)).ok, false);
  assert.equal((await changeScorer(attach({ narrow: "yes" }), every.deps)).ok, false);
  assert.equal(every.writes.length, 0);
  assert.equal((await changeScorer(attach({ narrow: true }), every.deps)).ok, true);

  const some = setup(checkDraft({ tasks: ["task-b"] }));
  assert.equal((await changeScorer(attach(), some.deps)).ok, true);
  const full = setup(checkDraft({ tasks: Array.from({ length: 50 }, (_, n) => `t${n}`) }));
  assert.equal((await changeScorer(attach(), full.deps)).ok, false);
  assert.equal(full.writes.length, 0);
});

test("an update moves a scorer between every trace and tasks, without repeats", async () => {
  const { deps, writes } = setup();
  const draft = checkDraft({ tasks: ["task-a", "task-a", "task-b"] });
  await changeScorer({ projectId: PROJECT, action: "update", scorerId: SCORER, draft }, deps);
  assert.deepEqual(writes[0]?.[3], checkDraft({ tasks: ["task-a", "task-b"] }));
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
    isRestricted: async () => false,
    get: async () =>
      ({
        ...current,
        id: SCORER,
        projectId: PROJECT,
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as Scorer,
    count: async () => 0,
    create: record("create", SCORER),
    update: record("update", true),
    setEnabled: record("setEnabled", true),
    attach: record("attach", true),
    detach: record("detach", true),
    remove: record("remove", true),
    observe: async (event) => {
      events.push(event);
    },
  };
  return { deps, writes, events };
}
