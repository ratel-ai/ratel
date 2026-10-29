import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkedCountingBody } from "@/lib/platform/http/test-support";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import {
  type CatalogSnapshotHandlerDeps,
  handleCatalogSnapshotRequest,
  MAX_CATALOG_SNAPSHOT_BYTES,
} from "./snapshot-handler";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function request(body: unknown): Request {
  return new Request("https://cloud.ratel.sh/api/v1/catalog/snapshot", {
    method: "PUT",
    headers: {
      authorization: "Bearer rtl_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function makeDeps(overrides: Partial<CatalogSnapshotHandlerDeps> = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const contexts: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const deps: CatalogSnapshotHandlerDeps = {
    resolveProjectFromBearer: async () => ({
      ok: true,
      projectId: PROJECT_ID,
      apiKeyId: "key-1",
    }),
    getOrganizationByProjectId: async () => ({ id: "org-1", slug: "ratel", plan: "free" }) as never,
    replaceCatalogSnapshot: async (projectId, snapshot) => {
      writes.push({ projectId, snapshot });
      return { changed: true };
    },
    rateLimiter: { consume: () => ({ allowed: true }) },
    setRequestLogContext: (_request, context) => contexts.push(context),
    trackServerEvent: async (event, context, properties) => {
      events.push({ event, context, properties });
    },
    logError: () => {},
    reportServerException: () => {},
    ...overrides,
  };
  return { deps, writes, contexts, events };
}

test("PUT stores a full source snapshot and returns its canonical ETag", async () => {
  const { deps, writes, contexts, events } = makeDeps();
  const response = await handleCatalogSnapshotRequest(
    request({
      source_id: "worker-a",
      tools: [{ id: "weather", name: "weather", description: "Forecasts" }],
    }),
    deps,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("etag") ?? "", /^"[a-f0-9]{64}"$/);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    sourceId: "worker-a",
    catalogVersion: response.headers.get("etag")?.slice(1, -1),
    tools: 1,
    unchanged: false,
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].projectId, PROJECT_ID);
  assert.deepEqual(contexts, [{ project_id: PROJECT_ID, org_id: "org-1" }]);
  assert.deepEqual(events, [
    {
      event: "catalog_snapshot_synced",
      context: { projectId: PROJECT_ID, orgId: "org-1" },
      properties: {
        object_action: "catalog_snapshot_synced",
        source_id: "worker-a",
        tool_count: 1,
        searchable_description_count: 0,
        unchanged: false,
      },
    },
  ]);
});

test("PUT reports exact replays as unchanged without changing the ETag", async () => {
  const { deps } = makeDeps({
    replaceCatalogSnapshot: async () => ({ changed: false }),
  });
  const response = await handleCatalogSnapshotRequest(
    request({ source_id: "worker-a", tools: [] }),
    deps,
  );

  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { unchanged: boolean }).unchanged, true);
  assert.match(response.headers.get("etag") ?? "", /^"[a-f0-9]{64}"$/);
});

test("PUT rate limits a hot-looping client before it can write", async () => {
  const throttled = makeDeps({
    rateLimiter: {
      consume: () => ({ allowed: false, retryAfterSeconds: 5 }),
    },
  });

  const response = await handleCatalogSnapshotRequest(
    request({ source_id: "worker-a", tools: [] }),
    throttled.deps,
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(throttled.writes.length, 0);
});

test("PUT rejects malformed and oversized snapshots without writes", async () => {
  const malformed = makeDeps();
  assert.equal(
    (
      await handleCatalogSnapshotRequest(
        request({ source_id: "worker-a", tools: [{ description: "missing name" }] }),
        malformed.deps,
      )
    ).status,
    400,
  );

  const oversized = makeDeps();
  const oversizedRequest = request({ source_id: "worker-a", tools: [] });
  oversizedRequest.headers.set("content-length", "4000001");
  assert.equal((await handleCatalogSnapshotRequest(oversizedRequest, oversized.deps)).status, 413);
  assert.equal(malformed.writes.length, 0);
  assert.equal(oversized.writes.length, 0);
});

test("PUT rejects a chunked over-cap body without full buffering", async () => {
  const MiB = 1024 * 1024;
  const { deps, writes } = makeDeps();
  const { stream, counters } = chunkedCountingBody({ chunkBytes: MiB, totalBytes: 8 * MiB });
  const chunked = new Request("https://cloud.ratel.sh/api/v1/catalog/snapshot", {
    method: "PUT",
    headers: {
      authorization: "Bearer rtl_test",
      "content-type": "application/json",
    },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const response = await handleCatalogSnapshotRequest(chunked, deps);

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: `Request body too large (max ${MAX_CATALOG_SNAPSHOT_BYTES} bytes).`,
  });
  assert.ok(
    counters.enqueuedBytes <= MAX_CATALOG_SNAPSHOT_BYTES + 2 * MiB,
    `handler should stop pulling near the cap; enqueued ${counters.enqueuedBytes} bytes`,
  );
  assert.equal(writes.length, 0);
});

test("PUT returns 429 with Retry-After when the API key is rate limited", async () => {
  const { deps, writes } = makeDeps();
  const rateLimitedDeps = {
    ...deps,
    rateLimiter: {
      consume: () => ({ allowed: false as const, retryAfterSeconds: 7 }),
    },
  };

  const response = await handleCatalogSnapshotRequest(
    request({ source_id: "worker-a", tools: [] }),
    rateLimitedDeps,
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.deepEqual(await response.json(), { error: "Rate limit exceeded." });
  assert.equal(writes.length, 0);
});

test("PUT rate limit capacity is isolated by API key, not project", async () => {
  const limiter = createTokenBucketRateLimiter({ limitPerMinute: 20, burst: 1 });
  const { deps } = makeDeps({
    resolveProjectFromBearer: async (incomingRequest) => ({
      ok: true,
      projectId: PROJECT_ID,
      apiKeyId: incomingRequest.headers.get("authorization") ?? "missing",
    }),
    rateLimiter: limiter,
  });
  const body = { source_id: "worker-a", tools: [] };
  const firstKeyRequest = request(body);
  firstKeyRequest.headers.set("authorization", "Bearer key-a");
  const secondKeyRequest = request(body);
  secondKeyRequest.headers.set("authorization", "Bearer key-b");
  const repeatedKeyRequest = request(body);
  repeatedKeyRequest.headers.set("authorization", "Bearer key-a");

  const firstKey = await handleCatalogSnapshotRequest(firstKeyRequest, deps);
  const secondKey = await handleCatalogSnapshotRequest(secondKeyRequest, deps);
  const repeatedKey = await handleCatalogSnapshotRequest(repeatedKeyRequest, deps);

  assert.equal(firstKey.status, 200);
  assert.equal(secondKey.status, 200);
  assert.equal(repeatedKey.status, 429);
  assert.equal(repeatedKey.headers.get("retry-after"), "3");
});

test("PUT logs and reports persistence failures before returning 500", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const reports: Array<Record<string, unknown>> = [];
  const failure = new Error("database unavailable");
  const { deps } = makeDeps({
    replaceCatalogSnapshot: async () => {
      throw failure;
    },
    logError: (message, error, fields) => logs.push({ message, error, fields }),
    reportServerException: (error, distinctId, context) => {
      reports.push({ error, distinctId, context });
    },
  });

  const response = await handleCatalogSnapshotRequest(
    request({ source_id: "worker-a", tools: [] }),
    deps,
  );

  assert.equal(response.status, 500);
  assert.deepEqual(logs, [
    {
      message: "catalog snapshot sync failed",
      error: failure,
      fields: { project_id: PROJECT_ID, source_id: "worker-a" },
    },
  ]);
  assert.deepEqual(reports, [
    {
      error: failure,
      distinctId: `project:${PROJECT_ID}`,
      context: { endpoint: "/api/v1/catalog/snapshot", source_id: "worker-a" },
    },
  ]);
});

test("PUT counts how many tools separated their searchable description", async () => {
  // The adoption signal. A publisher still on the old wire reports zero, which
  // is what tells us a re-sync would collapse retrieval text onto agent text.
  const { deps, events } = makeDeps();

  const response = await handleCatalogSnapshotRequest(
    request({
      source_id: "demo-app",
      tools: [
        {
          id: "add_task_comment",
          name: "add_task_comment",
          description: "Add a markdown comment to a task.",
          searchable_description: "comment note progress retro ping",
        },
        { id: "weather", name: "weather", description: "Forecasts" },
      ],
    }),
    deps,
  );

  assert.equal(response.status, 200);
  const properties = events[0].properties as Record<string, unknown>;
  assert.equal(properties.tool_count, 2);
  assert.equal(properties.searchable_description_count, 1);
});
