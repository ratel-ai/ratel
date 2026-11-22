import assert from "node:assert/strict";
import { test } from "node:test";
import type { StepContent } from "./inspect-load";
import {
  type PanelChat,
  type PanelRouteDeps,
  sessionPanelChatResponse,
  stepContentRequestFromUrl,
  stepContentResponse,
} from "./panel-route";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";

const CHAT: PanelChat = {
  textOff: false,
  turns: [
    {
      turnIndex: 1,
      ask: "Where is order 1234?",
      reply: "It shipped yesterday.",
      startedAt: "2026-11-02T09:00:00.000Z",
      endedAt: "2026-11-02T09:00:01.000Z",
      work: { actions: 1, tookMs: 1000, problems: 0, label: "1 action · 1 s" },
      traceId: "a".repeat(32),
    },
  ],
};
const CONTENT: StepContent = { calls: {}, query: "refund policy" };

function deps(overrides: Partial<PanelRouteDeps> = {}) {
  const calls = {
    loaded: [] as unknown[],
    logged: [] as string[],
    reported: 0,
    context: [] as unknown[],
  };
  const value: PanelRouteDeps = {
    getSession: async () => ({ userId: "user-1", externalId: "user_clerk" }),
    findProject: async (projectId) =>
      projectId === PROJECT ? { projectId, organizationId: "org-1" } : null,
    readContent: async () => true,
    loadChat: async (projectId, sessionId, readContent) => {
      calls.loaded.push({ projectId, sessionId, readContent });
      return CHAT;
    },
    loadStepContent: async (projectId, request, readContent) => {
      calls.loaded.push({ projectId, request, readContent });
      return CONTENT;
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

test("a member gets the session as chat, never cached, with the content opt-in passed through", async () => {
  const { value, calls } = deps({ readContent: async () => false });
  const response = await sessionPanelChatResponse(
    { projectId: PROJECT, sessionId: "ses_1" },
    value,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { ok: true, chat: CHAT });
  assert.deepEqual(calls.loaded, [{ projectId: PROJECT, sessionId: "ses_1", readContent: false }]);
  assert.deepEqual(calls.context, [
    { project_id: PROJECT, org_id: "org-1", distinct_id: "user_clerk" },
  ]);
});

test("a session with no finished turn is an ok answer with no chat", async () => {
  const { value } = deps({ loadChat: async () => null });
  const response = await sessionPanelChatResponse(
    { projectId: PROJECT, sessionId: "ses_1" },
    value,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, chat: null });
});

test("signed out reads nothing and asks to sign in", async () => {
  const { value, calls } = deps({ getSession: async () => null });
  const response = await sessionPanelChatResponse(
    { projectId: PROJECT, sessionId: "ses_1" },
    value,
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "Sign in to see this session." });
  assert.deepEqual(calls.loaded, []);
});

test("another project reads like a missing one", async () => {
  const { value, calls } = deps();
  const response = await sessionPanelChatResponse({ projectId: OTHER, sessionId: "ses_1" }, value);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "No project you belong to has that ID.",
  });
  assert.deepEqual(calls.loaded, []);
});

test("a failed read is logged, reported and answered with a retryable error", async () => {
  const { value, calls } = deps({
    loadChat: async () => {
      throw new Error("statement timeout");
    },
  });
  const response = await sessionPanelChatResponse(
    { projectId: PROJECT, sessionId: "ses_1" },
    value,
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "This session could not be loaded. Try again.",
  });
  assert.deepEqual(calls.logged, ["session_panel_chat_load_failed"]);
  assert.equal(calls.reported, 1);
});

test("a member gets a step's stored content", async () => {
  const { value, calls } = deps();
  const request = { eventIds: [EVENT], searchEventId: null };
  const response = await stepContentResponse({ projectId: PROJECT }, request, value);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { ok: true, content: CONTENT });
  assert.deepEqual(calls.loaded, [{ projectId: PROJECT, request, readContent: true }]);
});

test("step content keeps the action's answers: signed out, another project, failure", async () => {
  const request = { eventIds: [EVENT] };
  const signedOut = await stepContentResponse(
    { projectId: PROJECT },
    request,
    deps({ getSession: async () => null }).value,
  );
  assert.equal(signedOut.status, 401);
  assert.deepEqual(await signedOut.json(), { ok: false, error: "Sign in to see this step." });

  const other = await stepContentResponse({ projectId: OTHER }, request, deps().value);
  assert.equal(other.status, 404);
  assert.deepEqual(await other.json(), {
    ok: false,
    error: "No project you belong to has that ID.",
  });

  const failing = deps({
    loadStepContent: async () => {
      throw new Error("boom");
    },
  });
  const failed = await stepContentResponse({ projectId: PROJECT }, request, failing.value);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), {
    ok: false,
    error: "This step could not be loaded. Try again.",
  });
  assert.deepEqual(failing.calls.logged, ["step_content_load_failed"]);
});

test("the step content request reads repeated event ids and an optional search id from the query", () => {
  const url = new URL(`http://x/api?event=${EVENT}&event=${OTHER}&search=${EVENT}`);
  assert.deepEqual(stepContentRequestFromUrl(url), {
    eventIds: [EVENT, OTHER],
    searchEventId: EVENT,
  });
  assert.deepEqual(stepContentRequestFromUrl(new URL("http://x/api")), {
    eventIds: [],
    searchEventId: null,
  });
});
