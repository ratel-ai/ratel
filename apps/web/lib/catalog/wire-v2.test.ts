import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  type Catalog,
  canonicalSkill,
  etagOf,
  ifNoneMatchMatches,
  resolve,
  SKILL_FIELDS,
  type WireSkill,
} from "@/lib/catalog/wire-v2";

type Vectors = {
  catalogs: Record<string, Catalog>;
  etag: Array<{
    name: string;
    catalog: string;
    scope?: string | null;
    expect: { resolvedIds: string[]; etag: string };
  }>;
  equalEtags: string[][];
  distinctEtags: string[][];
  inm: Array<{
    name: string;
    current: string;
    of?: string;
    ifNoneMatch: { kind: string };
    expect: 200 | 304;
  }>;
  wire: { skillFields: string[]; forbiddenFieldSubstrings: string[] };
  canonical: Array<{ name: string; skill: WireSkill; expect: string }>;
};

const vectors: Vectors = JSON.parse(
  readFileSync(new URL("./__fixtures__/catalog-v2-vectors.json", import.meta.url), "utf8"),
);
const computed = new Map<string, { hex: string; etag: string }>();

for (const vector of vectors.etag) {
  test(`v2 etag vector: ${vector.name}`, () => {
    const catalog = vectors.catalogs[vector.catalog];
    assert.ok(catalog);
    const resolved = resolve(catalog, vector.scope ?? null);
    const tag = etagOf(resolved);
    computed.set(vector.name, tag);
    assert.deepEqual(
      resolved.map((skill) => skill.id),
      vector.expect.resolvedIds,
    );
    assert.equal(tag.etag, vector.expect.etag);
  });
}

test("v2 equal and distinct ETag groups match the protocol vectors", () => {
  for (const group of vectors.equalEtags) {
    assert.equal(new Set(group.map((name) => computed.get(name)?.etag)).size, 1);
  }
  for (const group of vectors.distinctEtags) {
    assert.equal(new Set(group.map((name) => computed.get(name)?.etag)).size, group.length);
  }
});

test("v2 canonicalizes omitted and null searchable descriptions identically", () => {
  for (const vector of vectors.canonical) {
    assert.equal(canonicalSkill(vector.skill), vector.expect, vector.name);
  }
  assert.deepEqual(vectors.wire.skillFields, [...SKILL_FIELDS]);
});

test("v2 If-None-Match behavior matches the protocol vectors", () => {
  for (const vector of vectors.inm) {
    const current = computed.get(vector.current);
    assert.ok(current);
    const other = vector.of ? computed.get(vector.of) : undefined;
    const header = buildIfNoneMatch(vector.ifNoneMatch.kind, current.etag, other?.etag);
    assert.equal(ifNoneMatchMatches(header, current.etag) ? 304 : 200, vector.expect, vector.name);
  }
});

function buildIfNoneMatch(kind: string, current: string, other?: string): string | null {
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
      return other ?? null;
    default:
      throw new Error(`unknown If-None-Match kind: ${kind}`);
  }
}
