import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pino from "pino";
import {
  createOpenAiEmbeddingProvider,
  embeddingProviderFromEnv,
  LOCAL_EMBEDDING_DIMENSIONS,
  localEmbedding,
} from "./embedding-provider";
import { OSS_LIMITS, ossEntitlements } from "./entitlements";
import { LOCAL_OPERATOR, ossSession } from "./session";
import { createOssTelemetry } from "./telemetry";

describe("oss session", () => {
  it("is one stable local operator with access and no acting-as", async () => {
    const a = await ossSession.resolvePrincipal();
    const b = await ossSession.resolvePrincipal();
    assert.deepEqual(a, LOCAL_OPERATOR);
    assert.equal(a?.id, b?.id);
    assert.match(LOCAL_OPERATOR.email ?? "", /\.invalid$/);
    assert.equal(await ossSession.accessGranted(LOCAL_OPERATOR), true);
    assert.equal(await ossSession.actingAs(), null);
  });
});

describe("oss entitlements", () => {
  const org = { id: "org_1" };

  it("never denies a creation quota and reports plan oss", () => {
    assert.equal(ossEntitlements.planId(org), "oss");
    assert.deepEqual(ossEntitlements.checkQuota(org, "maxProjects", 1_000_000), { ok: true });
    assert.equal(ossEntitlements.getLimits(org).maxMembers, Number.POSITIVE_INFINITY);
  });

  it("keeps every metered feature available with unlimited remaining budget", () => {
    const access = ossEntitlements.checkMeteredFeature(org, "matchQualityRunsPerMonth", 99, "Match quality");
    assert.equal(access.ok, true);
    if (access.ok) assert.equal(access.remaining, Number.POSITIVE_INFINITY);
  });

  it("still honours an operator's own limit overrides", () => {
    const capped = { id: "org_2", limitOverrides: { maxProjects: 2 } };
    assert.equal(ossEntitlements.getLimits(capped).maxProjects, 2);
    assert.equal(ossEntitlements.getLimits(capped).maxMembers, OSS_LIMITS.maxMembers);
    const blocked = ossEntitlements.checkQuota(capped, "maxProjects", 2);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.limit, 2);
  });
});

describe("oss telemetry", () => {
  function capture() {
    const lines: Array<Record<string, unknown>> = [];
    const logger = pino(
      { level: "info" },
      { write: (line: string) => void lines.push(JSON.parse(line)) },
    );
    return { logger, lines };
  }

  it("writes events as log lines with ids and numbers only", async () => {
    const { logger, lines } = capture();
    const telemetry = createOssTelemetry(logger);
    await telemetry.trackEvent(
      "intent_engine_clustered",
      { distinctId: "project:p1", projectId: "p1" },
      { asks: 12, joined: true, query: "where is my order", nested: { a: 1 }, lane: "runtime" },
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "intent_engine_clustered");
    assert.equal(lines[0].asks, 12);
    assert.equal(lines[0].lane, "runtime");
    assert.equal("query" in lines[0], false);
    assert.equal("nested" in lines[0], false);
  });

  it("reports exceptions without throwing", () => {
    const { logger, lines } = capture();
    const telemetry = createOssTelemetry(logger);
    assert.doesNotThrow(() => telemetry.reportException(new Error("boom"), "system:drain", { step: "x" }));
    assert.equal(lines[0].msg, "exception");
    assert.equal(lines[0].distinct_id, "system:drain");
  });
});

describe("oss embedding provider", () => {
  it("falls back to the local hash without a key and labels it local", async () => {
    const provider = embeddingProviderFromEnv({});
    assert.equal(provider.local, true);
    const [a, b, empty] = await provider.embed(["refund my order", "my order refund", ""]);
    assert.equal(a.length, LOCAL_EMBEDDING_DIMENSIONS);
    assert.deepEqual(a, localEmbedding("refund my order"));
    assert.deepEqual(a.map((v) => v.toFixed(6)), b.map((v) => v.toFixed(6)));
    assert.ok(empty.every((v) => v === 0));
  });

  it("calls an OpenAI-compatible endpoint when keyed and orders vectors by index", async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: headers.get("authorization") });
      return new Response(
        JSON.stringify({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const provider = createOpenAiEmbeddingProvider({ apiKey: "sk-test", baseUrl: "https://gw.example/v1/", fetch: fakeFetch });
    assert.equal(provider.local, false);
    assert.deepEqual(await provider.embed(["a", "b"]), [[1], [2]]);
    assert.equal(calls[0].url, "https://gw.example/v1/embeddings");
    assert.equal(calls[0].auth, "Bearer sk-test");
    assert.deepEqual(calls[0].body, { model: "text-embedding-3-small", input: ["a", "b"] });
  });

  it("selects the OpenAI provider from the environment", () => {
    const provider = embeddingProviderFromEnv({ OPENAI_API_KEY: "sk", OPENAI_EMBEDDING_MODEL: "m" });
    assert.equal(provider.local, false);
    assert.equal(provider.model, "m");
  });
});
