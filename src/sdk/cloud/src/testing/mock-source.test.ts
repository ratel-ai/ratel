import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceLayers } from "../canonical.js";
import { type MockSource, startMockSource } from "./mock-source.js";

const VECTORS_URL = new URL("../../../../../protocol/v1/conformance/vectors.json", import.meta.url);

interface EtagVector {
  name: string;
  catalog: string;
  scope: string | null;
  expect: { resolvedIds: string[]; etag: string };
}

interface InmVector {
  name: string;
  current: string;
  of?: string;
  ifNoneMatch: { kind: string };
  expect: 200 | 304;
}

interface VectorsDoc {
  catalogs: Record<string, SourceLayers>;
  etag: EtagVector[];
  equalEtags: string[][];
  distinctEtags: string[][];
  inm: InmVector[];
  wire: { skillFields: string[]; forbiddenFieldSubstrings: string[] };
}

const doc: VectorsDoc = JSON.parse(readFileSync(VECTORS_URL, "utf8"));
const API_KEY = "test-key";

let source: MockSource;

beforeAll(async () => {
  source = await startMockSource({ apiKey: API_KEY });
});

afterAll(async () => {
  await source.close();
});

function catalogUrl(scope: string | null): string {
  const url = new URL("/v1/catalog", source.url);
  if (scope !== null) url.searchParams.set("scope", scope);
  return url.toString();
}

async function get(
  scope: string | null,
  headers: Record<string, string> = { authorization: `Bearer ${API_KEY}` },
): Promise<Response> {
  return fetch(catalogUrl(scope), { headers });
}

describe("auth", () => {
  it("rejects a missing or wrong Bearer key with the frozen 401 body", async () => {
    source.setSkills([]);
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "Basic x" }]) {
      const res = await get(null, headers);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("unauthorized");
      expect(typeof body.error.message).toBe("string");
    }
  });

  it("serves /healthz unauthenticated", async () => {
    const res = await fetch(new URL("/healthz", source.url));
    expect(res.status).toBe(200);
  });

  it("answers an unknown /v1 path with the frozen 404 body", async () => {
    const res = await fetch(new URL("/v1/nope", source.url), {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});

describe("etag vectors over real HTTP", () => {
  const byName = new Map<string, string>();

  it.each(
    doc.etag.map((v) => [v.name, v] as const),
  )("vector %s: resolved ids, ETag header, bare catalogVersion", async (_name, v) => {
    source.setLayers(doc.catalogs[v.catalog]);
    const res = await get(v.scope);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(v.expect.etag);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const body = await res.json();
    expect(`"${body.catalogVersion}"`).toBe(v.expect.etag);
    expect(body.skills.map((s: { id: string }) => s.id)).toEqual(v.expect.resolvedIds);
    byName.set(v.name, v.expect.etag);
  });

  it.each(
    doc.equalEtags.map((g) => [g.join("+"), g] as const),
  )("equalEtags group %s", (_label, group) => {
    const tags = group.map((n) => byName.get(n));
    expect(tags.every((t) => t !== undefined)).toBe(true);
    expect(new Set(tags).size).toBe(1);
  });

  it.each(
    doc.distinctEtags.map((g) => [g.join("+"), g] as const),
  )("distinctEtags group %s", (_label, group) => {
    const tags = group.map((n) => byName.get(n));
    expect(tags.every((t) => t !== undefined)).toBe(true);
    expect(new Set(tags).size).toBe(group.length);
  });
});

describe("if-none-match vectors over real HTTP", () => {
  function etagVector(name: string): EtagVector {
    const v = doc.etag.find((e) => e.name === name);
    if (!v) throw new Error(`unknown etag vector: ${name}`);
    return v;
  }

  function buildHeader(kind: string, current: string, other?: string): string | null {
    switch (kind) {
      case "self":
        return current;
      case "weakSelf":
        return `W/${current}`;
      case "star":
        return "*";
      case "listWithSelf":
        return `"deadbeef", ${current}`;
      case "listMiss":
        return '"deadbeef", "c0ffeec0ffeec0ffee"';
      case "absent":
        return null;
      case "other":
        if (!other) throw new Error("kind=other needs an `of` vector");
        return other;
      default:
        throw new Error(`unknown If-None-Match kind: ${kind}`);
    }
  }

  it.each(doc.inm.map((v) => [v.name, v] as const))("inm vector %s", async (_name, v) => {
    const current = etagVector(v.current);
    const other = v.of ? etagVector(v.of) : undefined;
    source.setLayers(doc.catalogs[current.catalog]);
    const header = buildHeader(v.ifNoneMatch.kind, current.expect.etag, other?.expect.etag);
    const headers: Record<string, string> = { authorization: `Bearer ${API_KEY}` };
    if (header !== null) headers["if-none-match"] = header;
    const res = await get(current.scope, headers);
    expect(res.status).toBe(v.expect);
    if (v.expect === 304) {
      expect(await res.text()).toBe("");
    }
  });

  it("covers all committed inm vectors", () => {
    expect(doc.inm.length).toBe(7);
  });
});

describe("secrets never on the wire (structural)", () => {
  function forbiddenKeys(value: unknown, path = ""): string[] {
    if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => {
      const hit = doc.wire.forbiddenFieldSubstrings.some((sub) => key.toLowerCase().includes(sub));
      const here = hit ? [`${path}.${key}`] : [];
      return [...here, ...forbiddenKeys(v, `${path}.${key}`)];
    });
  }

  it("serves exactly the wire skillFields and no forbidden field name, for every fixture and scope", async () => {
    for (const [name, layers] of Object.entries(doc.catalogs)) {
      const scopes: (string | null)[] = [null, ...Object.keys(layers.subjects ?? {})];
      for (const scope of scopes) {
        source.setLayers(layers);
        const res = await get(scope);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(forbiddenKeys(body), `catalog ${name} scope ${scope}`).toEqual([]);
        for (const skill of body.skills) {
          expect(Object.keys(skill).sort()).toEqual([...doc.wire.skillFields].sort());
        }
      }
    }
  });
});

describe("request recording and failure injection", () => {
  it("records method, path, scope, if-none-match, and authorization", async () => {
    source.setSkills([]);
    source.requests.length = 0;
    await get("alice", { authorization: `Bearer ${API_KEY}`, "if-none-match": '"abc"' });
    expect(source.requests).toHaveLength(1);
    expect(source.requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/catalog",
      scope: "alice",
      ifNoneMatch: '"abc"',
      authorization: `Bearer ${API_KEY}`,
    });
  });

  it("injects an HTTP failure on the catalog endpoint until cleared", async () => {
    source.failWith("catalog", { kind: "http", status: 503 });
    const res = await get(null);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("unavailable");
    source.failWith("catalog", undefined);
    expect((await get(null)).status).toBe(200);
  });

  it("injects a network failure (socket destroyed)", async () => {
    source.failWith("catalog", { kind: "network" });
    await expect(get(null)).rejects.toThrow();
    source.failWith("catalog", undefined);
    expect((await get(null)).status).toBe(200);
  });

  it("injects failures on healthz independently", async () => {
    source.failWith("healthz", { kind: "http", status: 503 });
    expect((await fetch(new URL("/healthz", source.url))).status).toBe(503);
    source.failWith("healthz", undefined);
    expect((await fetch(new URL("/healthz", source.url))).status).toBe(200);
  });
});
