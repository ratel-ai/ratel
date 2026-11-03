import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import { createFixedWindowQuota } from "@/lib/synthesis/playground/quota";
import { type PlaygroundOperationDeps, playgroundOperations } from "./playground";

/**
 * The Playground, reached by an agent instead of by a person clicking.
 *
 * The route this reuses meters one thing: embedding-backed runs, because those
 * spend the provider credential. That is the right line for a browser, where a
 * human clicking is self-limiting. It is not the right line here. Every run,
 * BM25 included, re-reads the whole bench, and a loop iterating on a description
 * can do that as fast as the network allows. These tests pin both budgets and,
 * just as importantly, pin that they are charged for different things.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

const otherAuth: McpAuthContext = {
  kind: "api-key",
  projectId: "22222222-2222-4222-8222-222222222222",
  apiKeyId: "key-2",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

const bench = { skills: [], tools: [] };

function hit(id: string, rank: number, edited = false) {
  return {
    id,
    kind: "skill" as const,
    rank,
    score: 0.5,
    bm25Score: 0.5,
    embeddingScore: null,
    description: "x".repeat(5_000),
    searchableDescription: "y".repeat(5_000),
    searchableDescriptionSource: "searchable" as const,
    edited,
  };
}

function deps(overrides: Partial<PlaygroundOperationDeps> = {}): PlaygroundOperationDeps {
  return {
    loadBench: (async () => bench) as unknown as PlaygroundOperationDeps["loadBench"],
    embedTexts: (async () => ({
      ok: true,
      vectors: [],
      embeddedCount: 2,
      cachedCount: 1,
      local: false,
    })) as unknown as PlaygroundOperationDeps["embedTexts"],
    runPlayground: (() => ({
      baseline: { skills: [hit("refund-policy", 1)], tools: [] },
      drafted: { skills: [hit("refund-policy", 1)], tools: [] },
      diff: {
        skills: { entries: [], summary: { stable: 1, moved: 0, added: 0, dropped: 0 } },
        tools: { entries: [], summary: { stable: 0, moved: 0, added: 0, dropped: 0 } },
      },
      changes: [],
      hasEdits: false,
    })) as unknown as PlaygroundOperationDeps["runPlayground"],
    runQuota: createFixedWindowQuota(240, 3_600_000, () => 0),
    embeddingQuota: createFixedWindowQuota(60, 3_600_000, () => 0),
    now: () => 0,
    ...overrides,
  };
}

function run(
  params: Record<string, unknown>,
  overrides: Partial<PlaygroundOperationDeps> = {},
  options: { auth?: McpAuthContext; registryDeps?: PlaygroundOperationDeps } = {},
) {
  return dispatchOperation("test_retrieval", params, {
    registry: buildRegistry(playgroundOperations(options.registryDeps ?? deps(overrides))),
    auth: options.auth ?? auth,
  });
}

test("a run ranks the catalog and says nothing was written", async () => {
  const result = await run({ query: "how do refunds work" });

  assert.equal(result.ok, true);
  assert.ok(result.ok && result.hint?.includes("catalog as it stands"));
});

/**
 * The whole point of the operation. A ranked hit carries the full agent-facing
 * description and the full text it was matched on, each up to 4 KB. Returning
 * those for twenty-five hits across two runs would cost more context than the
 * ranking question was worth, which is the exact waste this product measures.
 */
test("ranked hits carry positions, not kilobytes of prose", async () => {
  const result = await run({ query: "refunds" });

  const [first] = (result as { data: { baseline: { skills: Array<Record<string, unknown>> } } })
    .data.baseline.skills;
  assert.equal(first.id, "refund-policy");
  assert.equal(first.rank, 1);
  assert.equal(first.description, undefined, "the agent already has the description");
  assert.equal(first.searchableDescription, undefined);
});

test("an edited hit keeps a preview of the text that was actually scored", async () => {
  // The one thing a caller cannot otherwise confirm: that the draft it sent is
  // the text the engine ranked, rather than the stored text it meant to replace.
  const result = await run(
    { query: "refunds", drafts: { skill: { "refund-policy": { description: "new text" } } } },
    {
      runPlayground: (() => ({
        baseline: { skills: [hit("refund-policy", 2)], tools: [] },
        drafted: { skills: [hit("refund-policy", 1, true)], tools: [] },
        diff: {
          skills: { entries: [], summary: { stable: 0, moved: 1, added: 0, dropped: 0 } },
          tools: { entries: [], summary: { stable: 0, moved: 0, added: 0, dropped: 0 } },
        },
        changes: [{ kind: "skill", id: "refund-policy", changes: [] }],
        hasEdits: true,
      })) as unknown as PlaygroundOperationDeps["runPlayground"],
    },
  );

  const data = result as {
    data: { drafted: { skills: Array<Record<string, unknown>> }; diff: unknown };
  };
  const drafted = data.data.drafted.skills[0];
  assert.equal(drafted.edited, true);
  assert.ok(typeof drafted.matchedText === "string" && drafted.matchedText.length < 400);
  assert.ok(data.data.diff, "a drafted run must say how the ranking changed");
});

test("an unedited run does not return the same ranking twice", async () => {
  const result = await run({ query: "refunds" });

  const data = (result as { data: Record<string, unknown> }).data;
  assert.ok(data.baseline);
  assert.equal(data.drafted, undefined, "identical to baseline; repeating it only costs tokens");
});

/**
 * The gap this operation had to close. The browser route leaves BM25 unmetered,
 * which is fine when the caller is a person. An agent loop is not a person, and
 * every run re-reads five tables sized by the customer's own traffic.
 */
test("plain BM25 runs are metered too, because the catalog read is not free", async () => {
  const shared = deps({ runQuota: createFixedWindowQuota(1, 3_600_000, () => 0) });

  const first = await run({ query: "a", mode: "bm25" }, {}, { registryDeps: shared });
  const second = await run({ query: "b", mode: "bm25" }, {}, { registryDeps: shared });

  assert.equal(first.ok, true);
  assert.equal(second.ok === false && second.error, "rate_limited");
  assert.ok(second.ok === false && (second.retryAfterSeconds ?? 0) > 0);
});

test("the embedding budget is spent only by the modes that call the provider", async () => {
  const shared = deps({ embeddingQuota: createFixedWindowQuota(1, 3_600_000, () => 0) });

  // Ten free runs must not consume the paid budget.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const free = await run({ query: "a", mode: "bm25" }, {}, { registryDeps: shared });
    assert.equal(free.ok, true);
  }
  const paid = await run({ query: "a", mode: "hybrid" }, {}, { registryDeps: shared });
  const exhausted = await run({ query: "a", mode: "embeddings" }, {}, { registryDeps: shared });

  assert.equal(paid.ok, true);
  assert.equal(exhausted.ok === false && exhausted.error, "rate_limited");
  assert.match(
    exhausted.ok === false ? exhausted.message : "",
    /bm25/,
    "an exhausted paid budget should point at the free path, not just refuse",
  );
});

test("one credential's runaway loop cannot spend another's budget", async () => {
  const shared = deps({ runQuota: createFixedWindowQuota(1, 3_600_000, () => 0) });

  await run({ query: "a" }, {}, { registryDeps: shared });
  const sameKey = await run({ query: "a" }, {}, { registryDeps: shared });
  const otherKey = await run({ query: "a" }, {}, { registryDeps: shared, auth: otherAuth });

  assert.equal(sameKey.ok === false && sameKey.error, "rate_limited");
  assert.equal(otherKey.ok, true);
});

test("an exhausted budget is refused before the catalog is read", async () => {
  let loaded = 0;
  const shared = deps({
    runQuota: createFixedWindowQuota(1, 3_600_000, () => 0),
    loadBench: (async () => {
      loaded += 1;
      return bench;
    }) as unknown as PlaygroundOperationDeps["loadBench"],
  });

  await run({ query: "a" }, {}, { registryDeps: shared });
  await run({ query: "a" }, {}, { registryDeps: shared });

  assert.equal(loaded, 1, "a refused run must not still pay for the work it refused");
});

test("a deployment with no embedding credential says so instead of failing opaquely", async () => {
  const result = await run(
    { query: "a", mode: "hybrid" },
    {
      embedTexts: (async () => ({
        ok: false,
        reason: "not_configured",
        status: 503,
      })) as unknown as PlaygroundOperationDeps["embedTexts"],
    },
  );

  assert.equal(result.ok === false && result.error, "unavailable");
  assert.match(result.ok === false ? result.message : "", /bm25/);
});

test("a locally-vectorized run admits it, so nobody tunes against a stand-in", async () => {
  const result = await run(
    { query: "a", mode: "embeddings" },
    {
      embedTexts: (async () => ({
        ok: true,
        vectors: [],
        embeddedCount: 1,
        cachedCount: 0,
        local: true,
      })) as unknown as PlaygroundOperationDeps["embedTexts"],
    },
  );

  const embedding = (result as { data: { embedding: { local: boolean } } }).data.embedding;
  assert.equal(embedding.local, true);
});

test("drafting only skills does not require an empty tool map alongside", async () => {
  const result = await run({
    query: "refunds",
    drafts: { skill: { "refund-policy": { description: "clearer text" } } },
  });

  assert.equal(result.ok, true);
});

test("drafting only tools works the same way round", async () => {
  const result = await run({
    query: "post a webhook",
    drafts: { tool: { http_post: { description: "send JSON over HTTP POST" } } },
  });

  assert.equal(result.ok, true);
});
