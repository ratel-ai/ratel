import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ExampleRouteDeps,
  sentimentExampleResponse,
  type TurnExample,
} from "@/lib/views/traces/sentiment/example";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const TURN = "33333333-3333-4333-8333-333333333333";

const EXAMPLE: TurnExample = {
  turnId: TURN,
  sessionId: "s-1",
  startedAt: "2026-09-01T09:00:00.000Z",
  text: true,
  request: "an invented request",
  steps: [
    {
      ordinal: 1,
      kind: "invoke",
      tool: "update_task",
      outcome: "error",
      hits: null,
      error: "validation_failed",
    },
  ],
  moreSteps: 0,
  reply: "an invented reply",
  next: null,
};

function deps(over: Partial<ExampleRouteDeps> = {}): {
  deps: ExampleRouteDeps;
  loaded: string[][];
  logged: Record<string, unknown>[];
} {
  const loaded: string[][] = [];
  const logged: Record<string, unknown>[] = [];
  return {
    loaded,
    logged,
    deps: {
      getSession: async () => ({ userId: "u-1", externalId: "user_1" }),
      findProject: async (projectId) =>
        projectId === PROJECT
          ? { projectId: PROJECT, organizationId: "org-1", enabled: true }
          : null,
      loadExample: async (projectId, turnId) => {
        loaded.push([projectId, turnId]);
        return turnId === TURN ? EXAMPLE : null;
      },
      setLogContext: () => {},
      logError: (fields) => void logged.push(fields),
      reportException: () => {},
      ...over,
    },
  };
}

test("a member gets the example, private and never cached", async () => {
  const { deps: d, loaded } = deps();
  const response = await sentimentExampleResponse({ projectId: PROJECT, turnId: TURN }, d);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { ok: true, example: EXAMPLE });
  assert.deepEqual(loaded, [[PROJECT, TURN]], "read within the project the person is a member of");
});

test("no session is 401, and nothing is read", async () => {
  const { deps: d, loaded } = deps({ getSession: async () => null });
  const response = await sentimentExampleResponse({ projectId: PROJECT, turnId: TURN }, d);
  assert.equal(response.status, 401);
  assert.deepEqual(loaded, []);
});

test("not a member, the page off for the organization, a turn of another project and a malformed id all read as not found", async () => {
  const other = deps();
  assert.equal(
    (
      await sentimentExampleResponse(
        { projectId: "22222222-2222-4222-8222-222222222222", turnId: TURN },
        other.deps,
      )
    ).status,
    404,
  );
  assert.deepEqual(other.loaded, []);

  const off = deps({
    findProject: async () => ({ projectId: PROJECT, organizationId: "org-1", enabled: false }),
  });
  assert.equal(
    (await sentimentExampleResponse({ projectId: PROJECT, turnId: TURN }, off.deps)).status,
    404,
  );
  assert.deepEqual(off.loaded, [], "the flag is checked before any read");

  const missing = deps();
  const response = await sentimentExampleResponse(
    { projectId: PROJECT, turnId: "44444444-4444-4444-8444-444444444444" },
    missing.deps,
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, message: "This example isn't available." });

  const malformed = deps();
  assert.equal(
    (
      await sentimentExampleResponse(
        { projectId: PROJECT, turnId: "1; drop table" },
        malformed.deps,
      )
    ).status,
    404,
  );
  assert.deepEqual(malformed.loaded, []);
});

test("a failed read is 500 with a plain message, logged without any text", async () => {
  const { deps: d, logged } = deps({
    loadExample: async () => {
      throw new Error("statement timeout");
    },
  });
  const response = await sentimentExampleResponse({ projectId: PROJECT, turnId: TURN }, d);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    message: "Couldn't load this example. Try again in a moment.",
  });
  assert.deepEqual(Object.keys(logged[0] ?? {}).sort(), ["err", "project_id"]);
});
