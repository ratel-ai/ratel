import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalSet,
  canonicalSkill,
  etagOf,
  resolveScope,
  type SourceLayers,
  skillsEqual,
} from "./canonical.js";

const VECTORS_URL = new URL("../../../../protocol/v1/conformance/vectors.json", import.meta.url);

interface EtagVector {
  name: string;
  catalog: string;
  scope: string | null;
  expect: { resolvedIds: string[]; etag: string };
}

interface VectorsDoc {
  catalogs: Record<string, SourceLayers>;
  etag: EtagVector[];
  equalEtags: string[][];
  distinctEtags: string[][];
}

const doc: VectorsDoc = JSON.parse(readFileSync(VECTORS_URL, "utf8"));

const skill = {
  id: "a-skill",
  name: "alpha-tool",
  description: "First tool.",
  tags: ["x", "y"],
  tools: ["t1"],
  metadata: { cat: ["a"] },
  body: "# Alpha\n",
};

describe("canonicalSkill", () => {
  it("emits exactly the 7 wire fields in the fixed key order", () => {
    expect(canonicalSkill(skill)).toBe(
      '{"id":"a-skill","name":"alpha-tool","description":"First tool.","tags":["x","y"],' +
        '"tools":["t1"],"metadata":{"cat":["a"]},"body":"# Alpha\\n"}',
    );
  });

  it("drops every non-wire field from the projection", () => {
    const noisy = { ...skill, createdAt: "2026-01-01T00:00:00Z", version: 7, status: "published" };
    expect(canonicalSkill(noisy)).toBe(canonicalSkill(skill));
  });

  it("sorts metadata keys by UTF-8 byte order and keeps value arrays authored", () => {
    const s = { ...skill, metadata: { cat: ["b", "a"], area: ["core"] } };
    expect(canonicalSkill(s)).toContain('"metadata":{"area":["core"],"cat":["b","a"]}');
  });

  it("keeps tags and tools in authored order", () => {
    expect(canonicalSkill({ ...skill, tags: ["y", "x"] })).not.toBe(canonicalSkill(skill));
  });

  it("emits non-ASCII as raw UTF-8, never \\u escapes", () => {
    const s = { ...skill, description: "café ☕", metadata: { área: ["café"] } };
    const canonical = canonicalSkill(s);
    expect(canonical).toContain("café ☕");
    expect(canonical).toContain('"área":["café"]');
    expect(canonical).not.toMatch(/\\u/);
  });

  it("defaults absent optional fields — parity with the SDK Skill shape", () => {
    const minimal = { id: "m", name: "min", description: "d" };
    expect(canonicalSkill(minimal)).toBe(
      '{"id":"m","name":"min","description":"d","tags":[],"tools":[],"metadata":{},"body":""}',
    );
  });
});

describe("canonicalSet", () => {
  it("sorts skills by id and joins them into a compact JSON array", () => {
    const other = { ...skill, id: "b-skill" };
    expect(canonicalSet([other, skill])).toBe(
      `[${canonicalSkill(skill)},${canonicalSkill(other)}]`,
    );
  });

  it("hashes an empty catalog as the two bytes []", () => {
    expect(canonicalSet([])).toBe("[]");
    expect(etagOf([]).hex).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  });
});

describe("etagOf", () => {
  it("returns the lowercase hex sha256 and the quoted strong tag", () => {
    const { hex, etag } = etagOf([skill]);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(etag).toBe(`"${hex}"`);
  });
});

describe("resolveScope", () => {
  const layers: SourceLayers = {
    global: [
      { ...skill, id: "g1", name: "search-web" },
      { ...skill, id: "g2", name: "send-email" },
    ],
    subjects: {
      alice: [
        { ...skill, id: "z-override", name: "search-web", body: "alice\n" },
        { ...skill, id: "a-extra", name: "list-files" },
      ],
    },
  };

  it("returns the global layer only when scope is absent", () => {
    expect(resolveScope(layers, null).map((s) => s.id)).toEqual(["g1", "g2"]);
    expect(resolveScope(layers, undefined).map((s) => s.id)).toEqual(["g1", "g2"]);
  });

  it("returns the global layer for an unknown subject", () => {
    expect(resolveScope(layers, "nobody").map((s) => s.id)).toEqual(["g1", "g2"]);
  });

  it("overlays the subject layer, subject wins on name collision, re-sorted by id", () => {
    const resolved = resolveScope(layers, "alice");
    expect(resolved.map((s) => s.id)).toEqual(["a-extra", "g2", "z-override"]);
    expect(resolved.find((s) => s.name === "search-web")?.body).toBe("alice\n");
  });
});

describe("skillsEqual", () => {
  it("compares exactly the 7 wire fields", () => {
    expect(skillsEqual(skill, { ...skill, extra: "noise" })).toBe(true);
    expect(skillsEqual(skill, { ...skill, body: "changed" })).toBe(false);
    expect(skillsEqual(skill, { ...skill, tags: ["y", "x"] })).toBe(false);
  });
});

describe("protocol/v1 conformance vectors", () => {
  // Iterate the committed file dynamically so new vectors are picked up.
  const byName = new Map<string, string>();
  for (const v of doc.etag) {
    const resolved = resolveScope(doc.catalogs[v.catalog], v.scope);
    byName.set(v.name, etagOf(resolved).etag);
  }

  it.each(
    doc.etag.map((v) => [v.name, v] as const),
  )("etag vector %s: resolvedIds and exact etag", (_name, v) => {
    const resolved = resolveScope(doc.catalogs[v.catalog], v.scope);
    expect(resolved.map((s) => s.id)).toEqual(v.expect.resolvedIds);
    expect(etagOf(resolved).etag).toBe(v.expect.etag);
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

  it("covers every vector in the file (none skipped)", () => {
    expect(doc.etag.length).toBeGreaterThan(0);
    expect(doc.equalEtags.length).toBeGreaterThan(0);
    expect(doc.distinctEtags.length).toBeGreaterThan(0);
  });
});
