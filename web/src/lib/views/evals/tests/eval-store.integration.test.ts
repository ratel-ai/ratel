import assert from "node:assert/strict";
import { test } from "node:test";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { approvedVersion, draftVersion } from "../domain/case";
import { currentVersion } from "../domain/eval";
import {
  content,
  createEvalsDb,
  evalContent,
  NO_REFUND,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  seedEval,
} from "./support";

const JUDGE = {
  id: "polite",
  name: "Polite",
  gating: false,
  definition: { kind: "judge" as const, config: { prompt: "polite?", output: "boolean" as const } },
};
const BY = { userId: "user_2", now: new Date("2026-11-26T10:00:00Z") };

async function setup() {
  const { db, client } = await createEvalsDb();
  return { db, client, evals: createDrizzleEvalStore(db), cases: createDrizzleCaseStore(db) };
}

test("an eval is created with its first version, and read by id, by name and in a list", async () => {
  const t = await setup();
  const made = await t.evals.create({
    projectId: PROJECT_ID,
    name: "Refunds",
    taskId: "task-refunds",
    content: evalContent({ sandboxName: "support-demo", params: { tone: "warm" }, trials: 5 }),
    createdBy: "user_1",
  });
  assert.ok(typeof made === "object");
  assert.equal(made.taskId, "task-refunds");
  const version = currentVersion(made);
  assert.deepEqual(
    {
      number: version.number,
      sandboxName: version.sandboxName,
      params: version.params,
      trials: version.trials,
      scorers: version.scorers,
      createdBy: version.createdBy,
    },
    {
      number: 1,
      sandboxName: "support-demo",
      params: { tone: "warm" },
      trials: 5,
      scorers: [NO_REFUND],
      createdBy: "user_1",
    },
  );
  assert.deepEqual(await t.evals.get(PROJECT_ID, made.id), made);
  assert.deepEqual(await t.evals.getByName(PROJECT_ID, "Refunds"), made);
  assert.equal(await t.evals.get(OTHER_PROJECT_ID, made.id), null);
  const second = await seedEval(t.db, { name: "Status" });
  assert.deepEqual(
    (await t.evals.list(PROJECT_ID)).map(({ id }) => id),
    [made.id, second.id],
  );
  assert.deepEqual(await t.evals.list(OTHER_PROJECT_ID), []);
});

test("two evals of a project do not share a name. Another project may use it", async () => {
  const t = await setup();
  await seedEval(t.db, { name: "Refunds" });
  const again = await t.evals.create({
    projectId: PROJECT_ID,
    name: "Refunds",
    taskId: null,
    content: evalContent(),
    createdBy: "user_1",
  });
  assert.equal(again, "name_taken");
  assert.ok(
    typeof (await seedEval(t.db, { name: "Refunds", projectId: OTHER_PROJECT_ID })) === "object",
  );
  const status = await seedEval(t.db, { name: "Status" });
  const renamed = await t.evals.update(
    PROJECT_ID,
    status.id,
    { name: "Refunds", taskId: null, content: evalContent() },
    currentVersion(status).id,
    BY,
  );
  assert.equal(renamed, "name_taken");
});

test("an edit adds a version only when the content changes, and keeps the older ones", async () => {
  const t = await setup();
  const made = await seedEval(t.db);
  const first = currentVersion(made);

  const renamed = await t.evals.update(
    PROJECT_ID,
    made.id,
    { name: "Refunds v2", taskId: "task-refunds", content: evalContent() },
    first.id,
    BY,
  );
  assert.ok(typeof renamed === "object");
  assert.deepEqual(
    [renamed.name, renamed.taskId, renamed.versions.length],
    ["Refunds v2", "task-refunds", 1],
  );

  const edited = await t.evals.update(
    PROJECT_ID,
    made.id,
    {
      name: "Refunds v2",
      taskId: "task-refunds",
      content: evalContent({ scorers: [NO_REFUND, JUDGE], trials: 1 }),
    },
    first.id,
    BY,
  );
  assert.ok(typeof edited === "object");
  const [newest, older] = edited.versions;
  assert.deepEqual(
    [newest?.number, newest?.trials, newest?.scorers, newest?.createdBy],
    [2, 1, [NO_REFUND, JUDGE], "user_2"],
  );
  assert.deepEqual(older, first, "the first version did not change");
  assert.deepEqual(await t.evals.versions([first.id]), [first]);
});

test("an edit from a version that is not the newest, or of another project, changes nothing", async () => {
  const t = await setup();
  const made = await seedEval(t.db);
  const first = currentVersion(made).id;
  const edit = { name: "Refunds", taskId: null, content: evalContent({ trials: 7 }) };
  assert.ok(typeof (await t.evals.update(PROJECT_ID, made.id, edit, first, BY)) === "object");
  const late = await t.evals.update(
    PROJECT_ID,
    made.id,
    { ...edit, content: evalContent({ trials: 9 }) },
    first,
    BY,
  );
  assert.equal(late, "changed");
  assert.equal(await t.evals.update(OTHER_PROJECT_ID, made.id, edit, first, BY), "not_found");
  assert.deepEqual(
    (await t.evals.get(PROJECT_ID, made.id))?.versions.map(({ trials }) => trials),
    [7, 3],
  );
});

test("the rows of a dataset have draft and approved versions, and belong to one eval", async () => {
  const t = await setup();
  const refunds = await seedEval(t.db);
  const status = await seedEval(t.db, { name: "Status" });
  const made = await t.cases.create({
    projectId: PROJECT_ID,
    evalId: refunds.id,
    name: "late refund",
    labels: [],
    content: content(),
    createdBy: "user_1",
  });
  assert.ok(typeof made === "object");
  assert.equal(made.evalId, refunds.id);
  const draft = draftVersion(made);
  assert.ok(draft);
  assert.equal(approvedVersion(made), null);
  await t.cases.approve(
    PROJECT_ID,
    made.id,
    { versionId: draft.id, updatedAt: draft.updatedAt },
    BY,
  );
  const saved = await t.cases.saveDraft(
    PROJECT_ID,
    made.id,
    { name: "late refund", labels: [], content: content({ expectedOutput: "No refund." }) },
    { versionId: draft.id, updatedAt: draft.updatedAt },
    new Date(),
  );
  assert.ok(typeof saved === "object");
  assert.deepEqual(
    saved.versions.map(({ number, state }) => [number, state]),
    [
      [2, "draft"],
      [1, "approved"],
    ],
  );
  assert.equal(Object.hasOwn(saved.versions[0] ?? {}, "scorers"), false, "no scorer on a case");
  assert.deepEqual(
    (await t.cases.list(PROJECT_ID, refunds.id)).map(({ id }) => id),
    [made.id],
  );
  assert.deepEqual(await t.cases.list(PROJECT_ID, status.id), []);

  const stranger = await seedEval(t.db, { name: "Theirs", projectId: OTHER_PROJECT_ID });
  const refused = await t.cases.create({
    projectId: PROJECT_ID,
    evalId: stranger.id,
    name: "x",
    labels: [],
    content: content(),
    createdBy: "user_1",
  });
  assert.equal(refused, "eval_not_found");
});
