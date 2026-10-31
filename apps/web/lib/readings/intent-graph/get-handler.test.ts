import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleIntentGraphGet,
  type IntentGraphGetHandlerDeps,
} from "@/lib/readings/intent-graph/get-handler";
import type { IntentGraphRow } from "@/lib/readings/intent-graph/schema";
import type { IntentGraphDocument } from "@/lib/readings/intent-types/wire";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const document: IntentGraphDocument = {
  v: 1,
  built_from_ts: 1753000000000,
  rev: 4,
  cluster_policy: { similarity: 0.7 },
  intents: [
    {
      id: "intent_0",
      label: "is the build green",
      terms: ["build"],
      members: ["why is the build broken"],
      support: 2,
      tools: { gh_run_list: 2 },
      skills: {},
      cohesion: 0.9,
    },
  ],
};

const row: IntentGraphRow = {
  projectId: PROJECT_ID,
  graphKey: "worker-a",
  producer: "runtime",
  document,
  rev: 4,
  schemaVersion: 1,
  model: null,
  builtFromTs: new Date(1753000000000),
  clusterCount: 1,
  byteSize: 300,
  contentHash: "abc",
  receivedAt: new Date(),
  updatedAt: new Date(),
  pulledAt: null,
  liveAt: null,
};

function request(source: string | null, headers: Record<string, string> = {}): Request {
  const url = new URL("https://cloud.ratel.sh/api/v1/intent-graph");
  if (source !== null) url.searchParams.set("source", source);
  return new Request(url, { headers: { authorization: "Bearer rtl_test", ...headers } });
}

function makeDeps(overrides: Partial<IntentGraphGetHandlerDeps> = {}) {
  const touches: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const logs: Array<{ message: string; fields: unknown }> = [];
  const deps: IntentGraphGetHandlerDeps = {
    resolveProjectFromBearer: async () => ({ ok: true, projectId: PROJECT_ID, apiKeyId: "key-1" }),
    getOrganizationByProjectId: async () => ({ id: "org-1", slug: "ratel", plan: "free" }) as never,
    getIntentGraph: async () => row,
    touchIntentGraphPull: async (projectId) => {
      touches.push(projectId);
    },
    rateLimiter: { consume: () => ({ allowed: true }) },
    setRequestLogContext: () => {},
    trackServerEvent: async (event, context, properties) => {
      events.push({ event, context, properties });
    },
    logError: (message, _error, fields) => logs.push({ message, fields }),
    ...overrides,
  };
  return { deps, touches, events, logs };
}

test("GET returns the stored document verbatim with ETag and no-cache", async () => {
  const { deps, touches, events } = makeDeps();
  const response = await handleIntentGraphGet(request("worker-a"), deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"abc"');
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.deepEqual(await response.json(), {
    sourceId: "worker-a",
    graphKey: "worker-a",
    rev: 4,
    graph: document,
  });
  assert.deepEqual(touches, [PROJECT_ID]);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "intent_graph_pulled");
});

test("If-None-Match hit is 304 with the same headers, no body, still touched, not tracked", async () => {
  const { deps, touches, events } = makeDeps();
  const response = await handleIntentGraphGet(
    request("worker-a", { "if-none-match": '"abc"' }),
    deps,
  );
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("etag"), '"abc"');
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.equal(await response.text(), "");
  assert.deepEqual(touches, [PROJECT_ID]);
  assert.equal(events.length, 0);
});

test("a stale If-None-Match is a full 200", async () => {
  const { deps } = makeDeps();
  const response = await handleIntentGraphGet(
    request("worker-a", { "if-none-match": '"old"' }),
    deps,
  );
  assert.equal(response.status, 200);
});

test("nothing stored is 404 not_found, and the pull was still recorded", async () => {
  const { deps, touches } = makeDeps({ getIntentGraph: async () => null });
  const response = await handleIntentGraphGet(request("worker-a"), deps);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
  assert.deepEqual(touches, [PROJECT_ID]);
});

test("a failing pull touch is logged and does not fail the request", async () => {
  const { deps, logs } = makeDeps({
    touchIntentGraphPull: async () => {
      throw new Error("db hiccup");
    },
  });
  const response = await handleIntentGraphGet(request("worker-a"), deps);
  assert.equal(response.status, 200);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].fields, {
    project_id: PROJECT_ID,
    source_id: "worker-a",
    graph_key: "worker-a",
  });
});

test("missing source is 400 invalid_request", async () => {
  const { deps, touches } = makeDeps();
  for (const req of [request(null), request("   ")]) {
    const response = await handleIntentGraphGet(req, deps);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "invalid_request",
      details: ["source query parameter is required"],
    });
  }
  assert.equal(touches.length, 0);
});

test("401 passes through", async () => {
  const { deps } = makeDeps({
    resolveProjectFromBearer: async () => ({
      ok: false,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    }),
  });
  assert.equal((await handleIntentGraphGet(request("a"), deps)).status, 401);
});

test("429 with Retry-After", async () => {
  const { deps } = makeDeps({
    rateLimiter: { consume: () => ({ allowed: false, retryAfterSeconds: 3 }) },
  });
  const response = await handleIntentGraphGet(request("a"), deps);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "3");
});

/* — serving key ————————————————————————————————————————————————————————————— */

function cloudDeps(liveAt: Date | null = new Date("2026-09-30T10:00:00Z")) {
  const asked: string[] = [];
  const touchedKeys: Array<string | undefined> = [];
  const cloudRow: IntentGraphRow = {
    ...row,
    graphKey: "cloud",
    producer: "cloud",
    rev: 9,
    contentHash: "cloudhash",
    document: { ...document, rev: 9 },
    liveAt,
  };
  const base = makeDeps({
    getIntentGraph: async (_projectId, key) => {
      asked.push(key);
      if (key === "cloud") return cloudRow;
      if (key === "cloud/worker-a") return { ...cloudRow, graphKey: "cloud/worker-a" };
      if (key === "worker-a") return row;
      return null;
    },
    touchIntentGraphPull: async (_projectId, _now, _db, graphKey) => {
      touchedKeys.push(graphKey);
    },
  });
  return { ...base, asked, touchedKeys };
}

test("source=cloud answers with the merged graph Ratel built, and records the pull under that key", async () => {
  const { deps, asked, touchedKeys, events } = cloudDeps();
  const response = await handleIntentGraphGet(request("cloud"), deps);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.graphKey, "cloud");
  assert.equal(body.rev, 9);
  assert.deepEqual(asked, ["cloud"]);
  assert.deepEqual(touchedKeys, ["cloud"]);
  assert.equal((events[0]?.properties as Record<string, unknown>).graph_key, "cloud");
});

test("a runtime asking for its own key gets its own graph, never a Ratel-built one", async () => {
  const { deps, asked } = cloudDeps();
  const response = await handleIntentGraphGet(request("worker-a"), deps);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.graphKey, "worker-a");
  assert.equal(body.rev, 4);
  assert.deepEqual(asked, ["worker-a"]);
});

test("a watching cloud graph is served like any other: a runtime goes live by pulling it", async () => {
  const { deps, events } = cloudDeps(null);
  const response = await handleIntentGraphGet(request("cloud"), deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"cloudhash"');
  const body = (await response.json()) as { graphKey: string; rev: number; graph: { rev: number } };
  assert.equal(body.graphKey, "cloud");
  assert.equal(body.rev, 9);
  assert.equal(body.graph.rev, 9);
  assert.equal((events[0]?.properties as Record<string, unknown>).rev, 9);

  const perSource = await handleIntentGraphGet(request("cloud/worker-a"), deps);
  assert.equal(((await perSource.json()) as { rev: number }).rev, 9);
});

test("a runtime's own graph is served as stored", async () => {
  const { deps } = cloudDeps(null);
  const response = await handleIntentGraphGet(request("worker-a"), deps);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { rev: number; graph: { intents: unknown[] } };
  assert.equal(body.rev, 4);
  assert.equal(body.graph.intents.length, 1);
});
