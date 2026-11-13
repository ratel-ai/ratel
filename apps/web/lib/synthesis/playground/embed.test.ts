import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmbeddingProviderPort } from "@/lib/contracts/embedding-provider";
import {
  clipInput,
  embeddingsConfigured,
  embedTexts,
  MAX_CACHE_ENTRIES,
  MAX_INPUT_CHARS,
  MAX_TEXTS,
  PROVIDER_BATCH_SIZE,
} from "@/lib/synthesis/playground/embed";

function fakeProvider(overrides: Partial<EmbeddingProviderPort> = {}) {
  const calls: string[][] = [];
  const provider: EmbeddingProviderPort = {
    model: "fake",
    local: false,
    isAvailable: () => true,
    embed: async (texts) => {
      calls.push([...texts]);
      return texts.map((_, index) => [index + 1, index + 1]);
    },
    ...overrides,
  };
  return { provider, calls };
}

test("embedTexts sends one input per distinct uncached text", async () => {
  const { provider, calls } = fakeProvider();
  const result = await embedTexts(["a", "b", "a"], { provider, cache: new Map() });

  assert.ok(result.ok);
  assert.deepEqual(calls, [["a", "b"]]);
  assert.equal(result.embeddedCount, 2);
  assert.equal(result.cachedCount, 1);
  assert.equal(result.vectors.length, 3);
  assert.deepEqual(result.vectors[0], result.vectors[2]);
});

test("a second call for the same text never reaches the provider", async () => {
  const { provider, calls } = fakeProvider();
  const deps = { provider, cache: new Map<string, number[]>() };

  await embedTexts(["a", "b"], deps);
  const second = await embedTexts(["b", "c"], deps);

  assert.ok(second.ok);
  assert.deepEqual(calls[1], ["c"]);
  assert.equal(second.embeddedCount, 1);
  assert.equal(second.cachedCount, 1);
});

test("a catalog larger than one provider batch is chunked, in order", async () => {
  const { provider, calls } = fakeProvider();
  const texts = Array.from({ length: PROVIDER_BATCH_SIZE + 30 }, (_, i) => `text ${i}`);
  const result = await embedTexts(texts, { provider, cache: new Map() });

  assert.ok(result.ok);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, PROVIDER_BATCH_SIZE);
  assert.equal(calls[1].length, 30);
  assert.equal(result.vectors.length, texts.length);
  assert.deepEqual(calls.flat(), texts);
});

test("a failing chunk stops the call and leaves earlier chunks cached", async () => {
  let seen = 0;
  const cache = new Map<string, number[]>();
  const { provider } = fakeProvider({
    embed: async (texts) => {
      seen += 1;
      if (seen > 1) throw new Error("embeddings endpoint answered 500");
      return texts.map(() => [1]);
    },
  });
  const texts = Array.from({ length: PROVIDER_BATCH_SIZE + 5 }, (_, i) => `t${i}`);
  const result = await embedTexts(texts, { provider, cache });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "upstream_unreachable");
  assert.equal(result.ok === false && result.status, 502);
  assert.equal(cache.size, PROVIDER_BATCH_SIZE);
});

test("embedTexts refuses a batch above the ceiling without calling the provider", async () => {
  const { provider, calls } = fakeProvider();
  const texts = Array.from({ length: MAX_TEXTS + 1 }, (_, i) => `t${i}`);
  const result = await embedTexts(texts, { provider, cache: new Map() });

  assert.equal(result.ok === false && result.reason, "too_many_inputs");
  assert.equal(result.ok === false && result.status, 400);
  assert.equal(calls.length, 0);
});

test("an unavailable provider is a configuration failure, not a call", async () => {
  const { provider, calls } = fakeProvider({ isAvailable: () => false });
  const result = await embedTexts(["a"], { provider, cache: new Map() });

  assert.equal(result.ok === false && result.reason, "not_configured");
  assert.equal(result.ok === false && result.status, 503);
  assert.equal(calls.length, 0);
  assert.equal(embeddingsConfigured(provider), false);
});

test("a provider returning the wrong number of vectors is rejected and caches nothing", async () => {
  const cache = new Map<string, number[]>();
  const { provider } = fakeProvider({ embed: async () => [[1]] });
  const result = await embedTexts(["a", "b"], { provider, cache });

  assert.equal(result.ok === false && result.reason, "upstream_unreadable");
  assert.equal(cache.size, 0);
});

test("a provider that never answers times out as unreachable", async () => {
  const { provider } = fakeProvider({ embed: () => new Promise(() => {}) });
  const result = await embedTexts(["a"], { provider, cache: new Map(), timeoutMs: 5 });

  assert.equal(result.ok === false && result.reason, "upstream_unreachable");
});

test("a local provider is labelled and costs nothing upstream", async () => {
  const cache = new Map<string, number[]>();
  const { provider, calls } = fakeProvider({ local: true });
  const result = await embedTexts(["a", "b"], { provider, cache });

  assert.ok(result.ok);
  assert.equal(result.local, true);
  assert.equal(result.embeddedCount, 0);
  assert.equal(result.cachedCount, 2);
  assert.deepEqual(calls, [["a", "b"]]);
  assert.equal(cache.size, 0);
});

test("a hosted provider's result is not labelled local", async () => {
  const { provider } = fakeProvider();
  const result = await embedTexts(["a"], { provider, cache: new Map() });

  assert.ok(result.ok);
  assert.equal(result.local, undefined);
});

test("a full cache evicting a text this call counted as a hit still returns its vector", async () => {
  const cache = new Map<string, number[]>();
  const { provider } = fakeProvider();
  const first = await embedTexts(["oldest"], { provider, cache });
  assert.ok(first.ok);
  for (let i = cache.size; i < MAX_CACHE_ENTRIES; i++) cache.set(`filler-${i}`, [0, 0]);

  const result = await embedTexts(["oldest", "new"], { provider, cache });

  assert.ok(result.ok);
  assert.deepEqual(result.vectors[0], first.vectors[0]);
  assert.equal(result.vectors[1].length, 2);
  assert.equal(result.embeddedCount, 1);
  assert.equal(result.cachedCount, 1);
});

test("clipInput trims and caps", () => {
  assert.equal(clipInput("  padded  "), "padded");
  assert.equal(clipInput("x".repeat(MAX_INPUT_CHARS + 500)).length, MAX_INPUT_CHARS);
});

test("clipped text is what gets sent", async () => {
  const { provider, calls } = fakeProvider();
  await embedTexts([`${"x".repeat(MAX_INPUT_CHARS)}TAIL`], { provider, cache: new Map() });

  assert.equal(calls[0][0].length, MAX_INPUT_CHARS);
  assert.equal(calls[0][0].endsWith("TAIL"), false);
});
