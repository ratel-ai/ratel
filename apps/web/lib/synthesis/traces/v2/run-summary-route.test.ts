import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunSpan } from "./run-summary";
import { type RunSummaryRouteDeps, runSummaryResponse } from "./run-summary-route";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const TRACE = "F7A19D4E000000000000000000000004";

const SPANS: RunSpan[] = [
  {
    spanId: "root",
    parentSpanId: null,
    name: "agent.run",
    spanClass: "other",
    operationName: "agent.run",
    model: null,
    startedAt: new Date("2026-09-03T10:43:35.413Z"),
    endedAt: new Date("2026-09-03T10:43:38.185Z"),
    durationMs: 2772,
    statusCode: 1,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    searchQuery: null,
    searchTarget: null,
    searchHitCount: null,
    attributes: {},
  },
];

function deps(overrides: Partial<RunSummaryRouteDeps> = {}) {
  const calls = {
    loaded: [] as string[],
    logged: [] as string[],
    reported: 0,
    context: [] as unknown[],
  };
  const value: RunSummaryRouteDeps = {
    getSession: async () => ({ userId: "user-1", externalId: "user_clerk" }),
    findProject: async (projectId) =>
      projectId === PROJECT ? { projectId, organizationId: "org-1" } : null,
    loadSpans: async (projectId, traceId) => {
      calls.loaded.push(`${projectId}/${traceId}`);
      return { spans: SPANS, truncated: false };
    },
    setLogContext: (context) => calls.context.push(context),
    logError: (_fields, message) => calls.logged.push(message),
    reportException: () => {
      calls.reported += 1;
    },
    ...overrides,
  };
  return { value, calls };
}

test("a member gets the run as a summary, never cached, read by the lowercase id ingest stores", async () => {
  const { value, calls } = deps();
  const response = await runSummaryResponse({ projectId: PROJECT, traceId: TRACE }, value);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.summary.title, "agent.run");
  assert.deepEqual(calls.loaded, [`${PROJECT}/${TRACE.toLowerCase()}`]);
  assert.deepEqual(calls.context, [
    { project_id: PROJECT, org_id: "org-1", distinct_id: "user_clerk" },
  ]);
});

test("strangers, signed-out readers and malformed ids learn nothing and load nothing", async () => {
  const stranger = deps();
  const other = await runSummaryResponse(
    { projectId: "22222222-2222-4222-8222-222222222222", traceId: TRACE },
    stranger.value,
  );
  assert.equal(other.status, 404);
  assert.equal(stranger.calls.loaded.length, 0);

  const signedOut = deps({ getSession: async () => null });
  assert.equal(
    (await runSummaryResponse({ projectId: PROJECT, traceId: TRACE }, signedOut.value)).status,
    401,
  );

  const malformed = deps();
  assert.equal(
    (await runSummaryResponse({ projectId: PROJECT, traceId: "not-a-trace" }, malformed.value))
      .status,
    404,
  );
  assert.equal(malformed.calls.loaded.length, 0);
});

test("a read the Panel already dropped skips the span load", async () => {
  const { value, calls } = deps({ aborted: () => true });
  const response = await runSummaryResponse({ projectId: PROJECT, traceId: TRACE }, value);
  assert.equal(response.status, 499);
  assert.equal(calls.loaded.length, 0);
  assert.equal(calls.logged.length, 0, "nothing failed, nothing to report");
});

test("a pruned run says so", async () => {
  const { value } = deps({ loadSpans: async () => ({ spans: [], truncated: false }) });
  const response = await runSummaryResponse({ projectId: PROJECT, traceId: TRACE }, value);
  assert.equal(response.status, 404);
  assert.match((await response.json()).message, /no longer retained/);
});

test("a failed read is logged and reported before the reader gets a retryable error", async () => {
  const { value, calls } = deps({
    loadSpans: async () => {
      throw new Error("statement timeout");
    },
  });
  const response = await runSummaryResponse({ projectId: PROJECT, traceId: TRACE }, value);
  assert.equal(response.status, 500);
  assert.match((await response.json()).message, /Try again/);
  assert.deepEqual(calls.logged, ["run summary load failed"]);
  assert.equal(calls.reported, 1);
});
