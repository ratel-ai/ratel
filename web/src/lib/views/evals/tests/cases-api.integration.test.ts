import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/support-session-policy";
import { createDrizzleCaseStore } from "../adapters/drizzle-case-store";
import {
  type CaseEvent,
  type CasesApiDeps,
  handleApproveCase,
  handleCreateCase,
  handleEditCase,
} from "../cases-api";
import { approvedVersion, type CaseContent } from "../domain/case";
import type { TurnContent } from "../domain/from-turn";
import { content, createEvalsDb, ORGANIZATION_ID, OTHER_PROJECT_ID, PROJECT_ID } from "./support";

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
  const store = createDrizzleCaseStore(db);
  const events: CaseEvent[] = [];
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
  const post = (body: unknown, d = deps(), projectId = PROJECT_ID) =>
    answer(handleCreateCase(request(body), projectId, d));
  const put = (caseId: string, body: unknown, d = deps(), projectId = PROJECT_ID) =>
    answer(handleEditCase(request(body), projectId, caseId, d));
  const approve = (caseId: string, draft: object, d = deps(), projectId = PROJECT_ID) =>
    answer(handleApproveCase(request(draft), projectId, caseId, d));
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
  return { client, deps, post, put, approve, get, rows, events, reads: () => reads, store };
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
  const { status, body } = await t.post({ turnId: TURN_ID });
  assert.equal(status, 201);
  const [version] = (await t.get(body.caseId)).versions;
  assert.equal(version?.state, "draft");
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
  const { status, body } = await t.post(edit());
  assert.equal(status, 201);
  const saved = await t.get(body.caseId);
  assert.equal(saved.name, "Late refund");
  assert.deepEqual(saved.labels, ["task:refunds", "intent:money back"]);
  const [version] = saved.versions;
  const { input, earlierTurns, toolFixtures, expectedOutput, scorers, sourceTurnId, sourceOutput } =
    version ?? assert.fail();
  assert.deepEqual({ input, earlierTurns, toolFixtures, expectedOutput, scorers }, content());
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

test("approve freezes the version, and an edit makes a new draft", async () => {
  const t = await setup();
  const { body: made } = await t.post(edit());
  const approved = await t.approve(made.caseId, made.draft);
  assert.deepEqual([approved.status, approved.body.state], [200, "approved"]);
  const [frozen] = await t.rows();
  assert.equal(frozen?.approved_by, "user_1");

  const { status, body } = await t.put(made.caseId, edit({ input: { message: "other" } }));
  assert.deepEqual([status, body.draft.number], [200, 2]);
  await t.put(made.caseId, edit({ input: { message: "third" } }));
  assert.equal((await t.approve(made.caseId, made.draft)).status, 409, "it is approved already");
  const [first, second, ...more] = await t.rows();
  assert.deepEqual(first, frozen, "the approved version did not change");
  assert.deepEqual([second?.state, second?.input, more.length], ["draft", { message: "third" }, 0]);
  assert.equal(approvedVersion(await t.get(made.caseId))?.number, 1, "the approved one counts");

  const { draft } = (await t.put(made.caseId, edit({ input: { message: "third" } }))).body;
  assert.equal((await t.approve(made.caseId, draft)).status, 200);
  assert.equal(approvedVersion(await t.get(made.caseId))?.number, 2);
  assert.deepEqual((await t.rows())[0], frozen);
});

test("an edit of the name of an approved case makes no draft", async () => {
  const t = await setup();
  const { body: made } = await t.post(edit());
  await t.approve(made.caseId, made.draft);
  const { body } = await t.put(made.caseId, { ...edit(), name: "New name" });
  assert.equal(body.draft, null);
  assert.equal((await t.get(made.caseId)).name, "New name");
});

test("a draft that changed after the person read it is not approved", async () => {
  const t = await setup();
  const { body: made } = await t.post(edit());
  await t.put(made.caseId, edit({ input: { message: "other" } }));
  const { status, body } = await t.approve(made.caseId, made.draft);
  assert.deepEqual([status, body.error], [409, "changed"]);
  assert.equal((await t.rows())[0]?.state, "draft");
});

test("a case with no gating scorer is not approved", async () => {
  const t = await setup();
  const { body: made } = await t.post({ turnId: TURN_ID });
  const { status, body } = await t.approve(made.caseId, made.draft);
  assert.deepEqual([status, body.error], [422, "not_ready"]);
});

test("another project, a stranger, the flag off and a support session change nothing", async () => {
  const t = await setup();
  const { body: made } = await t.post(edit());
  const before = await t.rows();
  const all = async (d: CasesApiDeps, projectId = PROJECT_ID) => [
    (await t.post(edit(), d, projectId)).status,
    (await t.put(made.caseId, edit({ input: 1 }), d, projectId)).status,
    (await t.approve(made.caseId, made.draft, d, projectId)).status,
  ];
  assert.deepEqual(await all(t.deps(), OTHER_PROJECT_ID), [404, 404, 404]);
  assert.deepEqual(await all(t.deps({ enabled: async () => false })), [404, 404, 404]);
  assert.deepEqual(await all(t.deps({ getSession: async () => null })), [401, 401, 401]);
  const restricted = t.deps({ isRestricted: async () => true });
  assert.deepEqual(await all(restricted), [403, 403, 403]);
  assert.equal((await t.post(edit(), restricted)).body.message, SUPPORT_SESSION_RESTRICTED_MESSAGE);
  const other = t.deps({
    findProjectScope: async (projectId) => ({
      project: { id: projectId },
      organization: { id: ORGANIZATION_ID },
      role: "member",
    }),
  });
  assert.equal((await t.put(made.caseId, edit(), other, OTHER_PROJECT_ID)).status, 404);
  assert.equal((await t.approve(made.caseId, made.draft, other, OTHER_PROJECT_ID)).status, 404);
  assert.deepEqual(await t.rows(), before);
});

test("a wrong body and a wrong id are refused", async () => {
  const t = await setup();
  assert.equal((await t.post({ ...edit(), name: " " })).status, 400);
  assert.equal((await t.post(null)).status, 400);
  assert.equal((await t.post(edit({ expectedOutput: "x".repeat(600_000) }))).status, 400);
  assert.equal((await t.put("nope", edit())).status, 404);
});

test("a label refers to no row: the tables of evals reference projects and cases only", async () => {
  const t = await setup();
  const { rows } = await t.client.query<{ target: string }>(`
    select distinct confrelid::regclass::text as target from pg_constraint
    where contype = 'f' and conrelid::regclass::text like 'eval_case%'`);
  assert.deepEqual(rows.map(({ target }) => target).sort(), ["eval_cases", "projects"]);
});

test("the routes of cases are create, edit and approve", () => {
  const root = fileURLToPath(new URL("../../../../app/api/projects", import.meta.url));
  const files = readdirSync(join(root, "[projectId]/evals/cases"), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith("route.ts"))
    .sort();
  assert.deepEqual(files, ["[caseId]/approve/route.ts", "[caseId]/route.ts", "route.ts"]);
});
