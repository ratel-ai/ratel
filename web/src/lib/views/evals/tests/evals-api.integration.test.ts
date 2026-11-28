import assert from "node:assert/strict";
import { test } from "node:test";
import { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/support-session-policy";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import { currentVersion } from "../domain/eval";
import { type EvalsApiDeps, handleCreateEval, handleEditEval } from "../evals-api";
import { createEvalsDb, NO_REFUND, ORGANIZATION_ID, PROJECT_ID } from "./support";

async function setup() {
  const { db } = await createEvalsDb();
  const store = createDrizzleEvalStore(db);
  const deps = (over: Partial<EvalsApiDeps> = {}): EvalsApiDeps => ({
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (projectId) =>
      projectId === PROJECT_ID
        ? { project: { id: projectId }, organization: { id: ORGANIZATION_ID }, role: "member" }
        : null,
    enabled: async () => true,
    isRestricted: async () => false,
    evals: () => store,
    now: () => new Date("2026-11-26T10:00:00Z"),
    ...over,
  });
  const send = async (response: Promise<Response>) => {
    const answer = await response;
    return { status: answer.status, body: await answer.json() };
  };
  const post = (body: unknown, d = deps()) =>
    send(handleCreateEval(request("POST", body), PROJECT_ID, d));
  const put = (evalId: string, body: unknown, d = deps()) =>
    send(handleEditEval(request("PUT", body), PROJECT_ID, evalId, d));
  return { store, deps, post, put };
}

const request = (method: string, body: unknown) =>
  new Request("http://x", { method, body: JSON.stringify(body) });

const definition = {
  name: "Refunds",
  taskId: "wf-refunds",
  content: {
    sandboxName: "support-demo",
    params: { tone: "warm" },
    trials: 2,
    scorers: [NO_REFUND],
  },
};

test("a person creates an eval with its sandbox, params, trials and scorers", async () => {
  const t = await setup();
  const { status, body } = await t.post(definition);
  assert.equal(status, 201);
  const made = await t.store.get(PROJECT_ID, body.evalId);
  assert.ok(made);
  assert.deepEqual([made.name, made.taskId], ["Refunds", "wf-refunds"]);
  const { sandboxName, params, trials, scorers } = currentVersion(made);
  assert.deepEqual(
    { sandboxName, params, trials, scorers },
    { sandboxName: "support-demo", params: { tone: "warm" }, trials: 2, scorers: [NO_REFUND] },
  );
  assert.equal(body.versionId, currentVersion(made).id);
  const again = await t.post(definition);
  assert.deepEqual([again.status, again.body.error], [409, "name_taken"]);
});

test("an edit of the scorers adds a version; an edit from an older version is refused", async () => {
  const t = await setup();
  const { body: made } = await t.post(definition);
  const judge = {
    id: "polite",
    name: "Polite",
    gating: false,
    definition: { kind: "judge", config: { prompt: "polite?", output: "boolean" } },
  };
  const edit = {
    ...definition,
    content: { ...definition.content, scorers: [NO_REFUND, judge] },
    base: made.versionId,
  };
  const { status, body } = await t.put(made.evalId, edit);
  assert.equal(status, 200);
  assert.equal(body.number, 2);
  const late = await t.put(made.evalId, { ...edit, content: definition.content });
  assert.deepEqual([late.status, late.body.error], [409, "changed"]);
  const found = await t.store.get(PROJECT_ID, made.evalId);
  assert.deepEqual(
    found?.versions.map(({ number, scorers }) => [number, scorers.length]),
    [
      [2, 2],
      [1, 1],
    ],
  );
});

test("a wrong eval is refused, and the flag off, another project or a support session change nothing", async () => {
  const t = await setup();
  const wrong = await t.post({ ...definition, content: { trials: 0 } });
  assert.deepEqual([wrong.status, wrong.body.error], [400, "invalid"]);
  assert.equal((await t.post(definition, t.deps({ enabled: async () => false }))).status, 404);
  const restricted = t.deps({ isRestricted: async () => true });
  assert.equal(
    (await t.post(definition, restricted)).body.message,
    SUPPORT_SESSION_RESTRICTED_MESSAGE,
  );
  assert.equal((await t.put("nope", { ...definition, base: PROJECT_ID })).status, 404);
  const other = await handleCreateEval(
    request("POST", definition),
    "33333333-3333-4333-8333-333333333333",
    t.deps(),
  );
  assert.equal(other.status, 404);
  assert.deepEqual(await t.store.list(PROJECT_ID), []);
});
