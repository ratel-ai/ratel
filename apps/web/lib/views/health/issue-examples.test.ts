import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type IssueExamples,
  type IssueExamplesDeps,
  issueExamplesResponse,
  MAX_ISSUES_PER_REQUEST,
  MAX_TURNS_PER_ISSUE,
  parseIssueIds,
  turnsPerIssue,
} from "@/lib/views/health/issue-examples";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STORY: IssueExamples = {
  id: A,
  total: 9,
  turns: [
    {
      turnId: "t1",
      traceId: null,
      startedAt: "2026-10-20T10:00:00.000Z",
      turnSource: "otlp",
      steps: [
        { kind: "search", query: { state: "captured", text: "where is my order" }, listed: 5 },
      ],
    },
  ],
};

function deps(over: Partial<IssueExamplesDeps> = {}) {
  const calls = {
    load: [] as unknown[],
    logged: [] as string[],
    reported: [] as unknown[],
    context: [] as unknown[],
  };
  const value: IssueExamplesDeps = {
    getSession: async () => ({ userId: "u1", externalId: "clerk_1" }),
    findProject: async () => ({
      projectId: PROJECT,
      organizationId: "o1",
      limits: { perIssue: 6, shown: Infinity },
    }),
    loadExamples: async (projectId, ids, limits) => {
      calls.load.push({ projectId, ids, limits });
      return [STORY];
    },
    setLogContext: (context) => calls.context.push(context),
    logError: (_fields, message) => calls.logged.push(message),
    reportException: (err) => calls.reported.push(err),
    ...over,
  };
  return { value, calls };
}

test("a member reads an issue's turns, cut to the plan, never cached", async () => {
  const { value, calls } = deps();
  const response = await issueExamplesResponse(PROJECT, `${A},${B}`, value);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { ok: true, locked: false, examples: [STORY] });
  assert.deepEqual(calls.load, [
    { projectId: PROJECT, ids: [A, B], limits: { perIssue: 6, shown: Infinity } },
  ]);
  assert.deepEqual(calls.context, [{ project_id: PROJECT, org_id: "o1", distinct_id: "clerk_1" }]);
});

test("a plan without example turns reads none and says so", async () => {
  const { value, calls } = deps({
    findProject: async () => ({
      projectId: PROJECT,
      organizationId: "o1",
      limits: { perIssue: 0, shown: 3 },
    }),
  });
  const response = await issueExamplesResponse(PROJECT, A, value);
  assert.deepEqual(await response.json(), { ok: true, locked: true, examples: [] });
  assert.equal(calls.load.length, 0);
});

test("no session, no membership and malformed ids read nothing", async () => {
  assert.equal(
    (await issueExamplesResponse(PROJECT, A, deps({ getSession: async () => null }).value)).status,
    401,
  );
  const outsider = deps({ findProject: async () => null });
  assert.equal((await issueExamplesResponse(PROJECT, A, outsider.value)).status, 404);
  assert.equal(outsider.calls.load.length, 0);
  for (const raw of [null, "", "not-an-id", `${A},drop table`]) {
    assert.equal(
      (await issueExamplesResponse(PROJECT, raw, deps().value)).status,
      400,
      String(raw),
    );
  }
});

test("a failed read is logged and reported, then answered kindly", async () => {
  const boom = new Error("statement timeout");
  const { value, calls } = deps({
    loadExamples: async () => {
      throw boom;
    },
  });
  const response = await issueExamplesResponse(PROJECT, A, value);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    message: "Couldn't load these examples. Try again in a moment.",
  });
  assert.deepEqual(calls.logged, ["issue examples load failed"]);
  assert.deepEqual(calls.reported, [boom]);
});

test("ids: each once, all well formed, a row's worth at most; turns: the plan's, capped", () => {
  assert.deepEqual(parseIssueIds(`${A}, ${B},${A}`), [A, B]);
  assert.equal(
    parseIssueIds(
      Array.from(
        { length: MAX_ISSUES_PER_REQUEST + 1 },
        (_, i) => `${i.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      ).join(","),
    ),
    null,
  );
  assert.equal(turnsPerIssue(0), 0);
  assert.equal(turnsPerIssue(3), 3);
  assert.equal(turnsPerIssue(Infinity), MAX_TURNS_PER_ISSUE);
  assert.equal(turnsPerIssue(500), MAX_TURNS_PER_ISSUE);
  assert.equal(turnsPerIssue(-1), 0);
});
