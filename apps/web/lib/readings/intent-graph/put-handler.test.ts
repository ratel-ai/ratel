import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleIntentGraphPut,
  type IntentGraphPutHandlerDeps,
} from "@/lib/readings/intent-graph/put-handler";
import type {
  PutIntentGraphInput,
  PutIntentGraphResult,
} from "@/lib/readings/intent-graph/queries";
import { type IntentGraphDocument, MAX_INTENT_GRAPH_BYTES } from "@/lib/readings/intent-types/wire";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER = "why is the build broken in the customer workspace";

function graph(over: Partial<IntentGraphDocument> = {}): IntentGraphDocument {
  return {
    v: 1,
    built_from_ts: 1753000000000,
    rev: 3,
    intents: [
      {
        id: "intent_0",
        label: MEMBER,
        terms: ["build"],
        members: [MEMBER],
        support: 2,
        tools: { gh_run_list: 2 },
        skills: {},
      },
    ],
    ...over,
  };
}

function request(body: unknown, headers: Record<string, string> = {}, rawBody?: string): Request {
  return new Request("https://cloud.ratel.sh/api/v1/intent-graph", {
    method: "PUT",
    headers: {
      authorization: "Bearer rtl_test",
      "content-type": "application/json",
      ...headers,
    },
    body: rawBody ?? JSON.stringify(body),
  });
}

function makeDeps(
  overrides: Partial<IntentGraphPutHandlerDeps> = {},
  outcome: PutIntentGraphResult = { outcome: "stored", rev: 3, etag: '"h1"' },
) {
  const puts: PutIntentGraphInput[] = [];
  const contexts: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const logs: Array<{ message: string; fields: unknown }> = [];
  const exceptions: unknown[] = [];
  const deps: IntentGraphPutHandlerDeps = {
    resolveProjectFromBearer: async () => ({ ok: true, projectId: PROJECT_ID, apiKeyId: "key-1" }),
    getOrganizationByProjectId: async () => ({ id: "org-1", slug: "ratel", plan: "free" }) as never,
    putIntentGraph: async (input) => {
      puts.push(input);
      return outcome;
    },
    rateLimiter: { consume: () => ({ allowed: true }) },
    setRequestLogContext: (_request, context) => contexts.push(context),
    trackServerEvent: async (event, context, properties) => {
      events.push({ event, context, properties });
    },
    logError: (message, _error, fields) => logs.push({ message, fields }),
    reportServerException: (error) => exceptions.push(error),
    ...overrides,
  };
  return { deps, puts, contexts, events, logs, exceptions };
}

test("PUT stores a graph and returns rev, unchanged, and the ETag", async () => {
  const { deps, puts, contexts, events } = makeDeps();
  const response = await handleIntentGraphPut(
    request({ source_id: "worker-a", graph: graph() }, { "if-match": '"h0"' }),
    deps,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"h1"');
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.deepEqual(await response.json(), { sourceId: "worker-a", rev: 3, unchanged: false });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].projectId, PROJECT_ID);
  assert.equal(puts[0].sourceId, "worker-a");
  assert.equal(puts[0].ifMatch, '"h0"');
  assert.ok(puts[0].byteSize > 0);
  assert.deepEqual(puts[0].graph, graph());
  assert.deepEqual(contexts, [{ project_id: PROJECT_ID, org_id: "org-1" }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "intent_graph_synced");
  assert.deepEqual(events[0].properties, {
    object_action: "intent_graph_synced",
    source_id: "worker-a",
    cluster_count: 1,
    byte_size: puts[0].byteSize,
    rev: 3,
    unchanged: false,
    has_model: false,
  });
});

test("an unchanged resave is reported as such", async () => {
  const { deps, events } = makeDeps({}, { outcome: "unchanged", rev: 3, etag: '"h1"' });
  const response = await handleIntentGraphPut(request({ source_id: "a", graph: graph() }), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sourceId: "a", rev: 3, unchanged: true });
  assert.equal((events[0].properties as { unchanged: boolean }).unchanged, true);
});

test("a stale write is 409 with the winning rev and ETag, and is not tracked", async () => {
  const { deps, events } = makeDeps({}, { outcome: "stale", rev: 9, etag: '"h9"' });
  const response = await handleIntentGraphPut(request({ source_id: "a", graph: graph() }), deps);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("etag"), '"h9"');
  assert.deepEqual(await response.json(), { error: "stale_graph", rev: 9, etag: '"h9"' });
  assert.equal(events.length, 0);
});

test("absent If-Match is passed through as null", async () => {
  const { deps, puts } = makeDeps();
  await handleIntentGraphPut(request({ source_id: "a", graph: graph() }), deps);
  assert.equal(puts[0].ifMatch, null);
});

test("415 for a non-JSON content type", async () => {
  const { deps, puts } = makeDeps();
  const response = await handleIntentGraphPut(request({}, { "content-type": "text/plain" }), deps);
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "unsupported_media_type" });
  assert.equal(puts.length, 0);
});

test("413 from a declared Content-Length over the cap, before auth", async () => {
  let authed = false;
  const { deps } = makeDeps({
    resolveProjectFromBearer: async () => {
      authed = true;
      return { ok: true, projectId: PROJECT_ID, apiKeyId: "key-1" };
    },
  });
  const response = await handleIntentGraphPut(
    request({}, { "content-length": String(MAX_INTENT_GRAPH_BYTES + 1) }),
    deps,
  );
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: "payload_too_large",
    max_bytes: MAX_INTENT_GRAPH_BYTES,
  });
  assert.equal(authed, false);
});

test("401 from the bearer resolver passes through", async () => {
  const { deps, puts } = makeDeps({
    resolveProjectFromBearer: async () => ({
      ok: false,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    }),
  });
  const response = await handleIntentGraphPut(request({ source_id: "a", graph: graph() }), deps);
  assert.equal(response.status, 401);
  assert.equal(puts.length, 0);
});

test("429 with Retry-After, and nothing is stored when throttled", async () => {
  const { deps, puts } = makeDeps({
    rateLimiter: { consume: () => ({ allowed: false, retryAfterSeconds: 7 }) },
  });
  const response = await handleIntentGraphPut(request({ source_id: "a", graph: graph() }), deps);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.deepEqual(await response.json(), { error: "rate_limited" });
  assert.equal(puts.length, 0);
});

test("400 invalid_json for a body that does not parse", async () => {
  const { deps } = makeDeps();
  const response = await handleIntentGraphPut(request(null, {}, "{not json"), deps);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json" });
});

test("400 invalid_graph carries rule paths and never a member string", async () => {
  const { deps, puts } = makeDeps();
  const response = await handleIntentGraphPut(
    request({
      source_id: "a",
      graph: graph({ v: 2 as never, intents: [{ ...graph().intents[0], support: 0 }] }),
    }),
    deps,
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string; details: string[] };
  assert.equal(body.error, "invalid_graph");
  assert.ok(body.details.length >= 2);
  for (const d of body.details) assert.ok(!d.includes(MEMBER));
  assert.equal(puts.length, 0);
});

test("500 path logs structured fields only and reports the exception", async () => {
  const { deps, logs, exceptions } = makeDeps({
    putIntentGraph: async () => {
      throw new Error("db down");
    },
  });
  const response = await handleIntentGraphPut(request({ source_id: "a", graph: graph() }), deps);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal_error" });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, "intent graph sync failed");
  assert.deepEqual(logs[0].fields, { project_id: PROJECT_ID, source_id: "a", cluster_count: 1 });
  assert.ok(!JSON.stringify(logs).includes(MEMBER));
  assert.equal(exceptions.length, 1);
});

test("a PUT under the reserved cloud key is refused with its own code and never stored", async () => {
  const { deps, puts, events } = makeDeps();
  const response = await handleIntentGraphPut(
    request({
      source_id: "cloud",
      graph: {
        v: 1,
        built_from_ts: 1753000000000,
        rev: 1,
        intents: [
          {
            id: "intent_0",
            label: "l",
            terms: [],
            members: ["why is the build broken"],
            support: 1,
            tools: { gh_run_list: 1 },
            skills: {},
          },
        ],
      },
    }),
    deps,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "reserved_key" });
  assert.equal(puts.length, 0);
  assert.equal(events.length, 0);

  // Cloud's per-source graphs live under the same reservation.
  const perSource = await handleIntentGraphPut(
    request({
      source_id: "cloud/acme-app",
      graph: { v: 1, built_from_ts: 1753000000000, rev: 1, intents: [] },
    }),
    deps,
  );
  assert.equal(perSource.status, 400);
  assert.deepEqual(await perSource.json(), { error: "reserved_key" });
  assert.equal(puts.length, 0);
});
