import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ExampleRouteDeps,
  exampleOf,
  exampleResponse,
} from "@/lib/views/health/self-corrections/example";

const ID = "4f9a2a6e-7d1b-4c6e-9b0a-2f3c4d5e6f70";
const REPLY = [
  { role: "assistant", content: [{ type: "text", text: "Sorry about that, let me try again." }] },
];
const ROW = { sourceEventId: "ev-1", matchStart: 0, matchEnd: 16 };

function deps(
  over: Partial<ExampleRouteDeps> = {},
): ExampleRouteDeps & { logged: string[]; reported: unknown[]; contexts: unknown[] } {
  const logged: string[] = [];
  const reported: unknown[] = [];
  const contexts: unknown[] = [];
  return {
    logged,
    reported,
    contexts,
    getSession: async () => ({ userId: "u1", externalId: "user_1" }),
    findProject: async (projectId) =>
      projectId === "p1" ? { projectId: "p1", organizationId: "o1" } : null,
    loadExample: async () => ({ row: ROW, reply: REPLY }),
    setLogContext: (context) => contexts.push(context),
    logError: (_fields, message) => logged.push(message),
    reportException: (error) => reported.push(error),
    ...over,
  };
}

async function call(params: { projectId: string; correctionId: string }, d: ExampleRouteDeps) {
  const response = await exampleResponse(params, d);
  return {
    status: response.status,
    body: await response.json(),
    cache: response.headers.get("cache-control"),
  };
}

test("a member reads the phrase and the words around it, never cached", async () => {
  const d = deps();
  const { status, body, cache } = await call({ projectId: "p1", correctionId: ID }, d);
  assert.equal(status, 200);
  assert.deepEqual(body, {
    ok: true,
    example: {
      state: "read",
      before: "",
      phrase: "Sorry about that",
      after: ", let me try again.",
    },
  });
  assert.equal(cache, "private, no-store");
  assert.deepEqual(d.contexts, [{ project_id: "p1", org_id: "o1", distinct_id: "user_1" }]);
});

test("a malformed id, a stranger and a missing row all read as not found; no session asks to sign in", async () => {
  assert.equal((await call({ projectId: "p1", correctionId: "nope" }, deps())).status, 404);
  assert.equal(
    (await call({ projectId: "p2", correctionId: ID }, deps())).status,
    404,
    "not a member reads like a missing project",
  );
  assert.equal(
    (
      await call(
        { projectId: "p1", correctionId: ID },
        deps({ loadExample: async () => ({ row: null, reply: null }) }),
      )
    ).status,
    404,
  );
  assert.equal(
    (await call({ projectId: "p1", correctionId: ID }, deps({ getSession: async () => null })))
      .status,
    401,
  );
});

test("a failed read is logged and reported, and says to try again", async () => {
  const d = deps({ loadExample: async () => Promise.reject(new Error("timeout")) });
  const { status, body } = await call({ projectId: "p1", correctionId: ID }, d);
  assert.equal(status, 500);
  assert.deepEqual(body, {
    ok: false,
    message: "Couldn't load this example. Try again in a moment.",
  });
  assert.deepEqual(d.logged, ["self correction example load failed"]);
  assert.equal(d.reported.length, 1);
});

test("what an example shows: the words, gone once the event is pruned, or nothing for a behaviour row", () => {
  assert.deepEqual(exampleOf(ROW, null), { ok: true, example: { state: "expired" } });
  assert.deepEqual(
    exampleOf({ ...ROW, matchEnd: 999 }, REPLY),
    { ok: true, example: { state: "expired" } },
    "a range past the reply",
  );
  assert.deepEqual(exampleOf({ sourceEventId: null, matchStart: null, matchEnd: null }, null), {
    ok: true,
    example: { state: "no_text" },
  });
});
