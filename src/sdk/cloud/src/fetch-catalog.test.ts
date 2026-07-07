import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CatalogSkillWire } from "./canonical.js";
import { CloudApiError, CloudAuthError, CloudUnavailableError } from "./errors.js";
import { fetchCatalog } from "./fetch-catalog.js";
import { type MockSource, startMockSource } from "./testing/mock-source.js";

const API_KEY = "test-key";

const skill: CatalogSkillWire = {
  id: "s1",
  name: "alpha",
  description: "First.",
  tags: ["x"],
  tools: [],
  metadata: {},
  body: "# A\n",
};

let source: MockSource;

beforeAll(async () => {
  source = await startMockSource({ apiKey: API_KEY });
});

afterAll(async () => {
  await source.close();
});

beforeEach(() => {
  source.setSkills([skill]);
  source.failWith("catalog", undefined);
  source.requests.length = 0;
});

describe("fetchCatalog", () => {
  it("GETs <url>/v1/catalog with the Bearer header and returns the changed catalog", async () => {
    const result = await fetchCatalog({ url: source.url, apiKey: API_KEY });
    expect(result.changed).toBe(true);
    if (!result.changed) throw new Error("unreachable");
    expect(result.catalog.skills.map((s) => s.id)).toEqual(["s1"]);
    expect(result.etag).toBe(`"${result.catalog.catalogVersion}"`);
    expect(source.requests[0]).toMatchObject({
      path: "/v1/catalog",
      scope: null,
      ifNoneMatch: null,
      authorization: `Bearer ${API_KEY}`,
    });
  });

  it("tolerates a trailing slash on the base url", async () => {
    const result = await fetchCatalog({ url: `${source.url}/`, apiKey: API_KEY });
    expect(result.changed).toBe(true);
    expect(source.requests[0]?.path).toBe("/v1/catalog");
  });

  it("passes the configured scope through as ?scope=", async () => {
    await fetchCatalog({ url: source.url, apiKey: API_KEY, scope: "alice" });
    expect(source.requests[0]?.scope).toBe("alice");
  });

  it("sends If-None-Match when an etag is known and reports unchanged on 304", async () => {
    const first = await fetchCatalog({ url: source.url, apiKey: API_KEY });
    if (!first.changed) throw new Error("expected a changed first fetch");
    const second = await fetchCatalog({ url: source.url, apiKey: API_KEY }, { etag: first.etag });
    expect(second.changed).toBe(false);
    expect(source.requests[1]?.ifNoneMatch).toBe(first.etag);
  });

  it("ignores unknown fields in the response body", async () => {
    const body = JSON.stringify({
      catalogVersion: "abc",
      skills: [{ ...skill, extra: "noise" }],
      futureField: 42,
    });
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { etag: '"abc"' },
      })) as typeof fetch;
    const result = await fetchCatalog({ url: "http://x", apiKey: API_KEY }, { fetchImpl });
    expect(result.changed).toBe(true);
  });

  it("falls back to the quoted catalogVersion when the ETag header is missing", async () => {
    const body = JSON.stringify({ catalogVersion: "abc", skills: [] });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const result = await fetchCatalog({ url: "http://x", apiKey: API_KEY }, { fetchImpl });
    if (!result.changed) throw new Error("expected changed");
    expect(result.etag).toBe('"abc"');
  });

  it("rejects a body without a string catalogVersion or a skills array", async () => {
    for (const bad of [
      JSON.stringify({ skills: [] }),
      JSON.stringify({ catalogVersion: 7, skills: [] }),
      JSON.stringify({ catalogVersion: "abc" }),
      JSON.stringify({ catalogVersion: "abc", skills: "nope" }),
      "not json",
    ]) {
      const fetchImpl = (async () => new Response(bad, { status: 200 })) as typeof fetch;
      await expect(
        fetchCatalog({ url: "http://x", apiKey: API_KEY }, { fetchImpl }),
      ).rejects.toBeInstanceOf(CloudApiError);
    }
  });

  it("maps 401 to CloudAuthError", async () => {
    await expect(fetchCatalog({ url: source.url, apiKey: "wrong" })).rejects.toBeInstanceOf(
      CloudAuthError,
    );
    await expect(fetchCatalog({ url: source.url })).rejects.toBeInstanceOf(CloudAuthError);
  });

  it("maps 503 to CloudUnavailableError", async () => {
    source.failWith("catalog", { kind: "http", status: 503 });
    await expect(fetchCatalog({ url: source.url, apiKey: API_KEY })).rejects.toBeInstanceOf(
      CloudUnavailableError,
    );
  });

  it("maps 404 to CloudApiError with status and code", async () => {
    source.failWith("catalog", { kind: "http", status: 404 });
    const err = await fetchCatalog({ url: source.url, apiKey: API_KEY }).catch((e) => e);
    expect(err).toBeInstanceOf(CloudApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
  });

  it("maps a network failure to CloudUnavailableError", async () => {
    source.failWith("catalog", { kind: "network" });
    await expect(fetchCatalog({ url: source.url, apiKey: API_KEY })).rejects.toBeInstanceOf(
      CloudUnavailableError,
    );
  });
});
