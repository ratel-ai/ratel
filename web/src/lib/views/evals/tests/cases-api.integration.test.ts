import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/support-session-policy";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import { createDrizzleEvalStore } from "../adapters/drizzle-eval-store";
import {
  type CaseEvent,
  type CasesApiDeps,
  handleCreateCase,
  handleEditCase,
  handleSaveOptions,
} from "../cases-api";
import { type CaseContent, currentVersion as currentRow } from "../domain/case";
import { currentVersion } from "../domain/eval";
import type { TurnContent } from "../domain/from-turn";
import type { TaskLinks } from "../ports/task-links";
import {
  content,
  createEvalsDb,
  ORGANIZATION_ID,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  seedEval,
} from "./support";

const TURN_ID = "99999999-9999-4999-8999-999999999999";
const TURN: TurnContent = {
  ask: null,
  messages: [
    { id: "1", role: "user", text: "refund A200" },
    { id: "2", role: "assistant", text: "Refunded.\0" },
  ],
  toolCalls: [
    {
      id: "c",
      name: "refund_order",
      arguments: { order_id: "A200" },
      result: { status: "refunded" },
      spanId: "s",
      durationMs: 1,
      statusCode: 0,
    },
  ],
};

async function setup() {
  const { db, client } = await createEvalsDb();
  const refunds = await seedEval(db);
  const store = createDrizzleCaseStore(db);
  const evals = createDrizzleEvalStore(db);
  const events: CaseEvent[] = [];
  const tasks: Record<string, Array<{ id: string; name: string }>> = {
    [TURN_ID]: [{ id: "wf-refunds", name: "Refund an order" }],
  };
  const taskLinks: TaskLinks = {
    tasksOfTurn: async (_projectId, turnId) => tasks[turnId] ?? [],
    tasksOfTrace: async (_projectId, traceId) => tasks[traceId] ?? [],
    defaultScorers: async () => [
      {
        id: "task-expected_tool",
        name: "Calls refund_order",
        gating: true,
        definition: {
          kind: "check",
          config: { path: "tools", op: "contains", value: "refund_order" },
        },
      },
    ],
    lastSandbox: async () => "support-demo",
  };
  let reads = 0;
  let clock = Date.parse("2026-11-25T10:00:00Z");
  const deps = (over: Partial<CasesApiDeps> = {}): CasesApiDeps => ({
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (projectId) =>
      projectId === PROJECT_ID
        ? { project: { id: projectId }, organization: { id: ORGANIZATION_ID }, role: "member" }
        : null,
    enabled: async () => true,
    isRestricted: async () => false,
    cases: () => store,
    evals: () => evals,
    taskLinks: () => taskLinks,
    readContent: async () => true,
    loadTurn: async (_projectId, turnId) => {
      reads += 1;
      return turnId === TURN_ID ? TURN : null;
    },
    readOnlyTools: async () => new Set(),
    track: async (event) => void events.push(event),
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    ...over,
  });
  const answer = async (response: Promise<Response>) => {
    const { status } = await response;
    return { status, body: await (await response).json() };
  };
  /** A body with no eval goes to the eval `Refunds`. The first case of the answer is `made`. */
  const post = async (body: unknown, d = deps(), projectId = PROJECT_ID) => {
    const answered = await answer(
      handleCreateCase(request(withEval(body, refunds.id)), projectId, d),
    );
    return { ...answered, made: answered.body.cases?.[0] };
  };
  /** With no base, the newest version as it is now. */
  const put = async (
    caseId: string,
    body: object,
    base?: object | null,
    d = deps(),
    projectId = PROJECT_ID,
  ) => {
    const newest = base ? null : (await store.get(PROJECT_ID, caseId))?.versions[0];
    const sent = base ?? { versionId: newest?.id ?? PROJECT_ID };
    return answer(handleEditCase(request({ ...body, base: sent }), projectId, caseId, d));
  };
  const get = async (caseId: string) => {
    const found = await store.get(PROJECT_ID, caseId);
    assert.ok(found);
    return found;
  };
  const rows = async () =>
    (
      await client.query<Record<string, unknown>>(
        "select * from eval_case_versions order by number",
      )
    ).rows;
  const options = async (query: string, d = deps()) => {
    const response = await handleSaveOptions(
      new Request(`http://x/save-target?${query}`),
      PROJECT_ID,
      d,
    );
    return { status: response.status, body: await response.json() };
  };
  return {
    client,
    db,
    refunds,
    evals,
    tasks,
    options,
    deps,
    post,
    put,
    get,
    rows,
    events,
    reads: () => reads,
    store,
  };
}

function withEval(body: unknown, evalId: string): unknown {
  const isObject = typeof body === "object" && body !== null && !Array.isArray(body);
  const named = isObject && ("evalId" in body || "newEval" in body || "targets" in body);
  return isObject && !named ? { evalId, ...body } : body;
}

const request = (body: unknown) =>
  new Request("http://x", { method: "POST", body: JSON.stringify(body) });
const edit = (over: Partial<CaseContent> = {}) => ({
  name: "Late refund",
  labels: ["task:refunds", "intent:money back"],
  content: content(over),
});

test("a case from a turn holds the input, the tool fixtures and the source turn", async () => {
  const t = await setup();
  const { status, made } = await t.post({ turnId: TURN_ID });
  assert.equal(status, 201);
  const [version] = (await t.get(made.caseId)).versions;
  assert.deepEqual([made.versionId, made.number], [version?.id, 1]);
  assert.equal(version?.sourceTurnId, TURN_ID);
  assert.equal(version?.sourceOutput, "Refunded.");
  assert.deepEqual(version?.input, { message: "refund A200" });
  assert.deepEqual(version?.toolFixtures, [
    { tool: "refund_order", arguments: { order_id: "A200" }, result: { status: "refunded" } },
  ]);
  assert.deepEqual(t.events, [{ name: "eval_case_created", source: "turn" }]);
});

test("a case with no trace holds only what the person typed", async () => {
  const t = await setup();
  const { status, made } = await t.post(edit());
  assert.equal(status, 201);
  const saved = await t.get(made.caseId);
  assert.equal(saved.name, "Late refund");
  assert.deepEqual(saved.labels, ["task:refunds", "intent:money back"]);
  const [version] = saved.versions;
  const { input, earlierTurns, toolFixtures, expectedOutput, sourceTurnId, sourceOutput } =
    version ?? assert.fail();
  assert.deepEqual({ input, earlierTurns, toolFixtures, expectedOutput }, content());
  assert.equal(saved.evalId, t.refunds.id);
  assert.deepEqual([sourceTurnId, sourceOutput], [null, null]);
  assert.equal(t.reads(), 0);
});

test("a person with no content access cannot make a case from a turn", async () => {
  const t = await setup();
  const { status, body } = await t.post(
    { turnId: TURN_ID },
    t.deps({ readContent: async () => false }),
  );
  assert.deepEqual([status, body.error], [403, "no_content_access"]);
  assert.equal(t.reads(), 0, "no captured text is read");
  assert.deepEqual(await t.rows(), []);
});

test("a turn of another project and a turn with no input give no case", async () => {
  const t = await setup();
  assert.equal((await t.post({ turnId: PROJECT_ID })).status, 404);
  const empty = { ask: null, messages: [], toolCalls: [] };
  const { status } = await t.post({ turnId: TURN_ID }, t.deps({ loadTurn: async () => empty }));
  assert.equal(status, 422);
});

test("a new row counts at once, and an edit adds a version that counts", async () => {
  const t = await setup();
  const { made } = await t.post(edit());
  assert.equal(currentRow(await t.get(made.caseId))?.number, 1);
  const [first] = await t.rows();
  const { status, body } = await t.put(made.caseId, edit({ input: { message: "other" } }));
  assert.deepEqual([status, body.number], [200, 2]);
  const [kept, second, ...more] = await t.rows();
  assert.deepEqual(kept, first, "the first version did not change");
  assert.deepEqual([second?.input, more.length], [{ value: { message: "other" } }, 0]);
  assert.equal(currentRow(await t.get(made.caseId))?.number, 2, "the newest counts");
});

test("an edit of the name only adds no version", async () => {
  const t = await setup();
  const { made } = await t.post(edit());
  const { body } = await t.put(made.caseId, { ...edit(), name: "New name" });
  assert.deepEqual([body.versionId, body.number], [made.versionId, 1]);
  assert.equal((await t.get(made.caseId)).name, "New name");
  assert.equal((await t.rows()).length, 1);
});

test("a row with no input is refused, on create and on edit", async () => {
  const t = await setup();
  const created = await t.post(edit({ input: null }));
  assert.deepEqual([created.status, created.body.error], [422, "no_input"]);
  const { made } = await t.post(edit());
  const edited = await t.put(made.caseId, edit({ input: null }));
  assert.deepEqual([edited.status, edited.body.error], [422, "no_input"]);
  assert.equal((await t.rows()).length, 1);
});

test("a case goes into the dataset of the eval that the request names, of its project only", async () => {
  const t = await setup();
  const other = await seedEval(t.db, { name: "Status" });
  const { status, made } = await t.post({ ...edit(), evalId: other.id });
  assert.equal(status, 201);
  assert.equal((await t.get(made.caseId)).evalId, other.id);
  const fromTurn = await t.post({ turnId: TURN_ID, evalId: other.id });
  assert.equal((await t.get(fromTurn.made.caseId)).evalId, other.id);
  assert.deepEqual(
    (await t.store.list(PROJECT_ID, other.id)).map(({ id }) => id).sort(),
    [made.caseId, fromTurn.made.caseId].sort(),
  );
  assert.deepEqual(await t.store.list(PROJECT_ID, t.refunds.id), []);

  const stranger = await seedEval(t.db, { name: "Theirs", projectId: OTHER_PROJECT_ID });
  const refused = await t.post({ ...edit(), evalId: stranger.id });
  assert.deepEqual([refused.status, refused.body.error], [404, "not_found"]);
  const missing = await t.post({ ...edit(), evalId: null });
  assert.deepEqual([missing.status, missing.body.error], [400, "invalid"]);
  assert.match(missing.body.message, /targets/);
  assert.equal((await t.rows()).length, 2);
});

test("another project, a stranger, the flag off and a support session change nothing", async () => {
  const t = await setup();
  const { made } = await t.post(edit());
  const before = await t.rows();
  const all = async (d: CasesApiDeps, projectId = PROJECT_ID) => [
    (await t.post(edit(), d, projectId)).status,
    (await t.put(made.caseId, edit({ input: 1 }), null, d, projectId)).status,
  ];
  assert.deepEqual(await all(t.deps(), OTHER_PROJECT_ID), [404, 404]);
  assert.deepEqual(await all(t.deps({ enabled: async () => false })), [404, 404]);
  assert.deepEqual(await all(t.deps({ getSession: async () => null })), [401, 401]);
  const restricted = t.deps({ isRestricted: async () => true });
  assert.deepEqual(await all(restricted), [403, 403]);
  assert.equal((await t.post(edit(), restricted)).body.message, SUPPORT_SESSION_RESTRICTED_MESSAGE);
  const other = t.deps({
    findProjectScope: async (projectId) => ({
      project: { id: projectId },
      organization: { id: ORGANIZATION_ID },
      role: "member",
    }),
  });
  assert.equal((await t.put(made.caseId, edit(), null, other, OTHER_PROJECT_ID)).status, 404);
  assert.deepEqual(await t.rows(), before);
});

test("a wrong body and a wrong id are refused", async () => {
  const t = await setup();
  const made = { versionId: TURN_ID };
  assert.equal((await t.post({ ...edit(), name: " " })).status, 400);
  assert.equal((await t.post(null)).status, 400);
  assert.equal((await t.post(edit({ expectedOutput: "x".repeat(600_000) }))).status, 400);
  assert.equal((await t.put("nope", edit(), made)).status, 404);
});

test("a label refers to no row: the tables of cases reference projects, cases and evals only", async () => {
  const t = await setup();
  const { rows } = await t.client.query<{ target: string }>(`
    select distinct confrelid::regclass::text as target from pg_constraint
    where contype = 'f' and conrelid::regclass::text like 'eval_case%'`);
  assert.deepEqual(rows.map(({ target }) => target).sort(), [
    "eval_cases",
    "eval_definitions",
    "projects",
  ]);
});

test("the routes of cases are create and edit: no approve", () => {
  const root = fileURLToPath(new URL("../../../../app/api/projects", import.meta.url));
  const files = readdirSync(join(root, "[projectId]/evals/cases"), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith("route.ts"))
    .sort();
  assert.deepEqual(files, ["[caseId]/route.ts", "route.ts"]);
});

test("text that looks like JSON stays text", async () => {
  const t = await setup();
  for (const input of ["123", "null", '{"a":1}']) {
    const { made } = await t.post(edit({ input }));
    assert.equal((await t.get(made.caseId)).versions[0]?.input, input);
  }
});

test("an edit of a form that another person changed is refused", async () => {
  const t = await setup();
  const { made } = await t.post(edit());
  const read = { versionId: made.versionId };
  assert.equal((await t.put(made.caseId, edit({ input: "A" }), read)).status, 200);
  const stale = await t.put(made.caseId, edit({ input: "B" }), read);
  assert.deepEqual([stale.status, stale.body.error], [409, "changed"]);
  assert.equal((await t.get(made.caseId)).versions[0]?.input, "A");
});

test("NUL is removed before the check, and JSON that is too deep is refused", async () => {
  const t = await setup();
  assert.equal((await t.post({ ...edit(), name: "\0" })).status, 400);
  const deep = `${"[".repeat(20_000)}${"]".repeat(20_000)}`;
  const body = JSON.stringify(edit()).replace('{"message":"refund A200"}', deep);
  const response = await handleCreateCase(
    new Request("http://x", { method: "POST", body }),
    PROJECT_ID,
    t.deps(),
  );
  assert.equal(response.status, 400);
});

test("save options: a turn of one task whose eval does not exist yet gets a new eval to confirm", async () => {
  const t = await setup();
  const { status, body } = await t.options(`turnId=${TURN_ID}`);
  assert.equal(status, 200);
  assert.equal(body.defaultTaskId, "wf-refunds");
  assert.deepEqual(body.targets["wf-refunds"], {
    kind: "new",
    name: "Refund an order",
    taskId: "wf-refunds",
    content: {
      sandboxName: "support-demo",
      params: {},
      trials: 3,
      scorers: [
        {
          id: "task-expected_tool",
          name: "Calls refund_order",
          gating: true,
          definition: {
            kind: "check",
            config: { path: "tools", op: "contains", value: "refund_order" },
          },
        },
      ],
    },
  });
  assert.deepEqual(body.evals, [{ id: t.refunds.id, name: "Refunds" }]);
});

test("save as eval case: a new eval is created with the task's scorers, then the next turn joins it", async () => {
  const t = await setup();
  const { body: options } = await t.options(`turnId=${TURN_ID}`);
  const target = options.targets["wf-refunds"];
  const first = await t.post({ turnId: TURN_ID, newEval: target });
  assert.equal(first.status, 201);
  const made = await t.evals.getByName(PROJECT_ID, "Refund an order");
  assert.ok(made);
  assert.equal(first.made.evalId, made.id);
  assert.equal(made.taskId, "wf-refunds");
  assert.deepEqual(
    currentVersion(made).scorers.map(({ name }) => name),
    ["Calls refund_order"],
  );
  assert.equal(currentVersion(made).sandboxName, "support-demo");
  const saved = await t.get(first.made.caseId);
  assert.deepEqual([saved.evalId, currentRow(saved)?.number], [made.id, 1]);
  assert.deepEqual(t.events.slice(0, 2), [
    { name: "eval_created", source: "save_case" },
    { name: "eval_case_created", source: "turn" },
  ]);

  // The eval exists now: the next save of a turn of the task goes into it.
  const { body: next } = await t.options(`turnId=${TURN_ID}`);
  assert.deepEqual(next.targets["wf-refunds"], {
    kind: "existing",
    evalId: made.id,
    name: "Refund an order",
    taskId: "wf-refunds",
  });
  const second = await t.post({ turnId: TURN_ID, evalId: made.id });
  assert.equal(second.made.evalId, made.id);
  // A second new eval of the same name is the eval that exists.
  const again = await t.post({ turnId: TURN_ID, newEval: target });
  assert.equal(again.made.evalId, made.id);
  assert.equal((await t.evals.list(PROJECT_ID)).length, 2);
});

test("save options: more tasks default to the task of the page, and no task asks for a name", async () => {
  const t = await setup();
  const trace = "a".repeat(32);
  t.tasks[trace] = [
    { id: "wf-refunds", name: "Refund an order" },
    { id: "wf-status", name: "Track an order" },
  ];
  assert.equal((await t.options(`traceId=${trace}`)).body.defaultTaskId, null);
  assert.equal(
    (await t.options(`traceId=${trace}&task=wf-status`)).body.defaultTaskId,
    "wf-status",
  );
  const none = await t.options(`traceId=${"b".repeat(32)}`);
  assert.deepEqual([none.body.tasks, none.body.defaultTaskId, none.body.targets], [[], null, {}]);
  const named = await t.post({ ...edit(), newEval: { name: "Smoke", taskId: null } });
  assert.equal(named.status, 201);
  const smoke = await t.evals.getByName(PROJECT_ID, "Smoke");
  assert.deepEqual([smoke?.taskId, smoke && currentVersion(smoke).scorers], [null, []]);
  const off = await t.options("", t.deps({ enabled: async () => false }));
  assert.equal(off.status, 404);
});

test("save options: a task with more evals lets the person choose one", async () => {
  const t = await setup();
  const hard = await seedEval(t.db, { name: "Refunds, hard" });
  await t.client.query("update eval_definitions set task_id = 'wf-refunds'");
  const { body } = await t.options(`turnId=${TURN_ID}`);
  assert.deepEqual(body.targets["wf-refunds"], {
    kind: "choose",
    taskId: "wf-refunds",
    evals: [
      { id: t.refunds.id, name: "Refunds" },
      { id: hard.id, name: "Refunds, hard" },
    ],
  });
});

test("a turn of two chosen tasks becomes one row in each chosen eval, or no row", async () => {
  const t = await setup();
  const status = await seedEval(t.db, { name: "Status" });
  const { body: options } = await t.options(`turnId=${TURN_ID}`);
  const { status: code, body } = await t.post({
    turnId: TURN_ID,
    targets: [{ evalId: status.id }, { newEval: options.targets["wf-refunds"] }],
  });
  assert.equal(code, 201);
  const made = await t.evals.getByName(PROJECT_ID, "Refund an order");
  assert.deepEqual(
    body.cases.map(({ evalId }: { evalId: string }) => evalId),
    [status.id, made?.id],
  );
  for (const { caseId } of body.cases) {
    assert.equal((await t.get(caseId)).versions[0]?.sourceTurnId, TURN_ID);
  }
  // The same eval twice is one row. An eval of another project saves no row.
  const twice = await t.post({
    ...edit(),
    targets: [{ evalId: status.id }, { evalId: status.id }],
  });
  assert.equal(twice.body.cases.length, 1);
  const stranger = await seedEval(t.db, { name: "Theirs", projectId: OTHER_PROJECT_ID });
  const before = (await t.rows()).length;
  const refused = await t.post({
    ...edit(),
    targets: [{ evalId: status.id }, { evalId: stranger.id }],
  });
  assert.deepEqual([refused.status, refused.body.error], [404, "not_found"]);
  assert.equal((await t.rows()).length, before);
});
