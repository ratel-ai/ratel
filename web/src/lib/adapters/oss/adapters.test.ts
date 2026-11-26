import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pino from "pino";
import { resolveConfig } from "@/config";
import {
  createOpenAiEmbeddingProvider,
  embeddingProviderFromConfig,
  LOCAL_EMBEDDING_DIMENSIONS,
  localEmbedding,
} from "./embedding-provider";
import { OSS_LIMITS, ossEntitlements } from "./entitlements";
import {
  createOssSession,
  LOCAL_OPERATOR,
  LOCAL_ORGANIZATION_ID,
  localOrganization,
  ossSession,
} from "./session";
import { createOssTelemetry } from "./telemetry";

describe("oss session", () => {
  // A request that has arrived.
  const session = createOssSession({ connection: async () => {} });

  it("is one local operator, admin of one organization, with no acting-as", async () => {
    const a = await session.resolveSession();
    const b = await session.resolveSession();
    assert.deepEqual(a, b);
    assert.equal(a?.user, LOCAL_OPERATOR);
    assert.match(LOCAL_OPERATOR.email ?? "", /\.invalid$/);
    assert.equal(a?.organization.id, LOCAL_ORGANIZATION_ID);
    assert.equal(a?.role, "admin");
    assert.deepEqual(a?.memberships, [{ organization: a?.organization, role: "admin" }]);
    assert.equal(await session.actingAs(), null);
  });

  it("waits for the request before it answers, as a signed-in edition's session does", async () => {
    const order: string[] = [];
    const waiting = createOssSession({
      connection: async () => {
        order.push("connection");
      },
    });
    const resolved = await waiting.resolveSession();
    order.push(`session:${resolved?.user.id}`);
    assert.deepEqual(order, ["connection", "session:local-operator"]);
  });

  it("never answers while the request is pending, so a prerender cannot bake the session", async () => {
    let answered = false;
    void createOssSession({ connection: () => new Promise<void>(() => {}) })
      .resolveSession()
      .then(() => {
        answered = true;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(answered, false);
  });

  it("the composed port answers outside Next, where nothing is prerendered", async () => {
    assert.deepEqual(await ossSession.resolveSession(), await session.resolveSession());
  });

  it("names the organization from app.organizationName, keeping its id and slug", () => {
    const named = localOrganization(resolveConfig({ env: { RATEL_ORG_NAME: "  Acme Labs " } }));
    assert.deepEqual(named, { id: LOCAL_ORGANIZATION_ID, name: "Acme Labs", slug: "local" });
    assert.equal(localOrganization(resolveConfig()).name, "Local operator");
  });

  it("knows its own organization only, with one member", async () => {
    assert.equal((await session.getOrganization(LOCAL_ORGANIZATION_ID))?.id, LOCAL_ORGANIZATION_ID);
    assert.equal(await session.getOrganization("00000000-0000-4000-8000-000000000999"), null);
    assert.equal(await session.countMembers(LOCAL_ORGANIZATION_ID), 1);
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
    const access = ossEntitlements.checkMeteredFeature(
      org,
      "matchQualityRunsPerMonth",
      99,
      "Match quality",
    );
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

  it("has no event cap: the quota check always allows and recording usage changes nothing", async () => {
    assert.deepEqual(await ossEntitlements.checkEventQuota(org), { ok: true });
    await ossEntitlements.recordEventUsage(org, 1_000_000);
    assert.deepEqual(await ossEntitlements.checkEventQuota(org), { ok: true });
    const capped = { id: "org_2", limitOverrides: { monthlyEventLimit: 1 } };
    assert.deepEqual(
      await ossEntitlements.checkEventQuota(capped),
      { ok: true },
      "no counter exists to compare an override against",
    );
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
    assert.doesNotThrow(() =>
      telemetry.reportException(new Error("boom"), "system:drain", { step: "x" }),
    );
    assert.equal(lines[0].msg, "exception");
    assert.equal(lines[0].distinct_id, "system:drain");
  });
});

describe("oss telemetry content guard", () => {
  function capture() {
    const lines: Array<Record<string, unknown>> = [];
    const logger = pino(
      { level: "info" },
      { write: (line: string) => void lines.push(JSON.parse(line)) },
    );
    return { logger, lines };
  }

  it("drops content-shaped strings from the context and from exception properties too", async () => {
    const { logger, lines } = capture();
    const telemetry = createOssTelemetry(logger);
    await telemetry.trackEvent(
      "query_intents_clustered",
      { distinctId: "project:p1", orgId: "how do I cancel my order", projectId: "p1" },
      { members: ["refund my order"], count: 2, label: "cancel an order" },
    );
    telemetry.reportException(new Error("boom"), "system:jobs", {
      step: "prune",
      query: "where is my refund",
      nested: { prompt: "..." },
    });
    const [event, exception] = lines;
    assert.equal(event.distinctId, "project:p1");
    assert.equal(event.projectId, "p1");
    assert.equal(event.count, 2);
    for (const key of ["orgId", "members", "label"]) assert.ok(!(key in event), `${key} leaked`);
    assert.equal(exception.distinct_id, "system:jobs");
    assert.equal(exception.step, "prune");
    for (const key of ["query", "nested"]) assert.ok(!(key in exception), `${key} leaked`);
  });
});

describe("oss embedding provider", () => {
  it("falls back to the local hash without a key and labels it local", async () => {
    const provider = embeddingProviderFromConfig(resolveConfig());
    assert.equal(provider.local, true);
    const [a, b, empty] = await provider.embed(["refund my order", "my order refund", ""]);
    assert.equal(a.length, LOCAL_EMBEDDING_DIMENSIONS);
    assert.deepEqual(a, localEmbedding("refund my order"));
    assert.deepEqual(
      a.map((v) => v.toFixed(6)),
      b.map((v) => v.toFixed(6)),
    );
    assert.ok(empty.every((v) => v === 0));
  });

  it("calls an OpenAI-compatible endpoint when keyed and orders vectors by index", async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: headers.get("authorization"),
      });
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [2] },
            { index: 0, embedding: [1] },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const provider = createOpenAiEmbeddingProvider({
      apiKey: "sk-test",
      baseUrl: "https://gw.example/v1/",
      fetch: fakeFetch,
    });
    assert.equal(provider.local, false);
    assert.deepEqual(await provider.embed(["a", "b"]), [[1], [2]]);
    assert.equal(calls[0].url, "https://gw.example/v1/embeddings");
    assert.equal(calls[0].auth, "Bearer sk-test");
    assert.deepEqual(calls[0].body, { model: "text-embedding-3-small", input: ["a", "b"] });
  });

  it("selects the OpenAI provider from the environment", () => {
    const provider = embeddingProviderFromConfig(
      resolveConfig({
        env: {
          OPENAI_API_KEY: "sk",
          OPENAI_EMBEDDING_MODEL: "m",
        },
      }),
    );
    assert.equal(provider.local, false);
    assert.equal(provider.model, "m");
  });
});
