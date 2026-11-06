import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmbeddingProviderPort } from "@/lib/contracts/embedding-provider";
import type { Bench } from "./catalog";
import type { RankResponse } from "./contract";
import { createFixedWindowQuota } from "./quota";
import { type RankRouteDeps, rankResponse } from "./rank-route";
import { BENCH_SKILL_DEFAULTS } from "./test-support";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const BENCH: Bench = {
  skills: [
    {
      ...BENCH_SKILL_DEFAULTS,
      id: "s1",
      name: "make-changelog",
      description: "Write a changelog from the commit log.",
      tags: [],
      tools: [],
      status: "published",
      version: 1,
    },
  ],
  tools: [],
  truncated: { skills: false, tools: false },
};

function provider(overrides: Partial<EmbeddingProviderPort> = {}): EmbeddingProviderPort {
  return {
    model: "fake",
    local: false,
    isAvailable: () => true,
    embed: async (texts) => texts.map(() => [1, 0]),
    ...overrides,
  };
}

function harness(overrides: Partial<RankRouteDeps> = {}) {
  const tracked: Array<Record<string, unknown>> = [];
  const logged: string[] = [];
  const contexts: Array<Record<string, string>> = [];
  const deps: RankRouteDeps = {
    getSession: async () => ({ userId: "u1", externalId: "ext-1" }),
    findProject: async (id) => (id === PROJECT_ID ? { projectId: id, organizationId: "o1" } : null),
    loadBench: async () => BENCH,
    provider: provider(),
    quota: createFixedWindowQuota(10, 60_000),
    embedCache: new Map(),
    setLogContext: (context) => contexts.push(context),
    logError: (_fields, message) => logged.push(message),
    trackRun: async (properties) => {
      tracked.push(properties);
    },
    ...overrides,
  };
  return { deps, tracked, logged, contexts };
}

const body = (extra: Record<string, unknown> = {}) => ({
  projectId: PROJECT_ID,
  query: "write the changelog",
  ...extra,
});

test("no session is a 401", async () => {
  const { deps } = harness({ getSession: async () => null });
  assert.equal((await rankResponse(body(), deps)).status, 401);
});

test("an invalid run is a 400 with its issues", async () => {
  const { deps } = harness();
  const response = await rankResponse({ projectId: PROJECT_ID, query: "" }, deps);
  assert.equal(response.status, 400);
  assert.ok(((await response.json()) as { issues: unknown[] }).issues.length > 0);
});

test("another organization's project is a 404", async () => {
  const { deps } = harness();
  const response = await rankResponse(body({ projectId: "someone-else" }), deps);
  assert.equal(response.status, 404);
});

test("a keyword run ranks without embedding or spending quota", async () => {
  const embedded: string[][] = [];
  const quota = createFixedWindowQuota(1, 60_000);
  const { deps, tracked, contexts } = harness({
    quota,
    provider: provider({
      embed: async (texts) => {
        embedded.push([...texts]);
        return texts.map(() => [1, 0]);
      },
    }),
  });

  const response = await rankResponse(body(), deps);
  const payload = (await response.json()) as RankResponse;

  assert.equal(response.status, 200);
  assert.equal(payload.embedding, null);
  assert.equal(embedded.length, 0);
  assert.equal(quota.consume("ext-1").allowed, true);
  assert.deepEqual(tracked, [{ mode: "bm25", edited_capabilities: 0, embedded_inputs: 0 }]);
  assert.deepEqual(contexts, [{ project_id: PROJECT_ID, org_id: "o1", distinct_id: "ext-1" }]);
});

test("an embedding run reports what it cost and what quota is left", async () => {
  const { deps, tracked } = harness();
  const response = await rankResponse(body({ mode: "embeddings" }), deps);
  const payload = (await response.json()) as RankResponse;

  assert.equal(response.status, 200);
  assert.equal(payload.embedding?.local, false);
  assert.equal(payload.embedding?.remaining, 9);
  assert.ok((payload.embedding?.embeddedCount ?? 0) > 0);
  assert.equal(tracked[0].mode, "embeddings");
  assert.equal(tracked[0].embedded_inputs, payload.embedding?.embeddedCount);
});

test("a run on the local vectorizer says so", async () => {
  const { deps } = harness({ provider: provider({ local: true }) });
  const payload = (await (
    await rankResponse(body({ mode: "hybrid" }), deps)
  ).json()) as RankResponse;
  assert.equal(payload.embedding?.local, true);
  assert.equal(payload.embedding?.embeddedCount, 0);
});

test("the quota turns an embedding run away with its reset time", async () => {
  const { deps } = harness({ quota: createFixedWindowQuota(0, 60_000) });
  const response = await rankResponse(body({ mode: "embeddings" }), deps);
  assert.equal(response.status, 429);
  assert.ok(((await response.json()) as { resetAt: string }).resetAt);
});

test("a provider failure is a logged 502 and no tracked run", async () => {
  const { deps, tracked, logged } = harness({
    provider: provider({
      embed: async () => {
        throw new Error("embeddings endpoint answered 500");
      },
    }),
  });
  const response = await rankResponse(body({ mode: "embeddings" }), deps);

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "The embedding provider is unavailable. Try again shortly.",
  });
  assert.equal(logged.length, 1);
  assert.equal(tracked.length, 0);
});

test("an unavailable provider is a 503 with its own message", async () => {
  const { deps } = harness({ provider: provider({ isAvailable: () => false }) });
  const response = await rankResponse(body({ mode: "hybrid" }), deps);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Embeddings are not configured for this environment.",
  });
});
