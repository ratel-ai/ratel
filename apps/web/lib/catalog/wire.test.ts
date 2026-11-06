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
} from "@/lib/catalog/wire";

/**
 * The vendored copy of the protocol's conformance vectors
 * (`protocol/v1/conformance/vectors.json` in the `ratel` repo). Re-running its
 * committed expectations against this module is the byte-for-byte proof that
 * Cloud's ETag/resolve implementation conforms. If these drift, re-vendor the
 * file and reconcile — do not "fix" the module to match a stale copy.
 */
type Vectors = {
  catalogs: Record<string, Catalog>;
  etag: {
    name: string;
    catalog: string;
    scope?: string | null;
    expect: { resolvedIds: string[]; etag: string };
  }[];
  equalEtags: string[][];
  distinctEtags: string[][];
  inm: {
    name: string;
    current: string;
    of?: string;
    ifNoneMatch: { kind: string };
    expect: 200 | 304;
  }[];
  wire: { skillFields: string[]; forbiddenFieldSubstrings: string[] };
};

const vectors: Vectors = JSON.parse(
  readFileSync(new URL("./__fixtures__/catalog-vectors.json", import.meta.url), "utf8"),
);

// name -> the etag we computed, so the equal/distinct/inm groups can reference it.
const computed = new Map<string, { hex: string; etag: string }>();

for (const v of vectors.etag) {
  test(`etag vector: ${v.name}`, () => {
    const catalog = vectors.catalogs[v.catalog];
    assert.ok(catalog, `unknown catalog "${v.catalog}"`);
    const resolved = resolve(catalog, v.scope ?? null);
    const tag = etagOf(resolved);
    computed.set(v.name, tag);
    assert.deepEqual(
      resolved.map((s) => s.id),
      v.expect.resolvedIds,
      "resolved id order",
    );
    assert.equal(tag.etag, v.expect.etag, "strong ETag");
  });
}

test("equal-etag groups hash identically", () => {
  for (const group of vectors.equalEtags) {
    const tags = group.map((n) => computed.get(n)?.etag);
    assert.equal(new Set(tags).size, 1, `[${group}] must be equal, got ${JSON.stringify(tags)}`);
  }
});

test("distinct-etag groups are pairwise distinct", () => {
  for (const group of vectors.distinctEtags) {
    const tags = group.map((n) => computed.get(n)?.etag);
    assert.equal(
      new Set(tags).size,
      group.length,
      `[${group}] must be distinct, got ${JSON.stringify(tags)}`,
    );
  }
});

function buildInm(
  kind: string,
  current: { etag: string },
  other?: { etag: string },
): string | null {
  switch (kind) {
    case "self":
      return current.etag;
    case "weakSelf":
      return "W/" + current.etag;
    case "star":
      return "*";
    case "listWithSelf":
      return '"deadbeef", ' + current.etag;
    case "listMiss":
      return '"deadbeef", "c0ffeec0ffeec0ffee"';
    case "absent":
      return null;
    case "other":
      assert.ok(other, "vector needs `of`");
      return other.etag;
    default:
      throw new Error(`unknown If-None-Match kind: ${kind}`);
  }
}

for (const v of vectors.inm) {
  test(`if-none-match vector: ${v.name}`, () => {
    const current = computed.get(v.current);
    assert.ok(current, `unknown current vector "${v.current}"`);
    const other = v.of ? computed.get(v.of) : undefined;
    const header = buildInm(v.ifNoneMatch.kind, current, other);
    const status = ifNoneMatchMatches(header, current.etag) ? 304 : 200;
    assert.equal(status, v.expect);
  });
}

test("canonical projection emits exactly the frozen fields — never a secret", () => {
  // Structural guard: a skill carrying extra/forbidden fields still canonicalizes
  // to only the seven wire fields, so nothing secret can leak into the ETag bytes.
  const noisy = {
    id: "z",
    name: "z",
    description: "d",
    tags: ["t"],
    tools: ["tool-a"],
    metadata: { k: ["v"] },
    body: "b",
    // extra fields a source might carry internally:
    apiKey: "rtl_secret",
    authorization: "Bearer nope",
    createdAt: "2026-01-01",
  } as unknown as WireSkill;
  const bytes = canonicalSkill(noisy);
  const parsed = JSON.parse(bytes);
  assert.deepEqual(Object.keys(parsed), [...SKILL_FIELDS]);
  for (const forbidden of vectors.wire.forbiddenFieldSubstrings) {
    for (const key of Object.keys(parsed)) {
      assert.ok(
        !key.toLowerCase().includes(forbidden),
        `wire field "${key}" contains forbidden substring "${forbidden}"`,
      );
    }
  }
});

test("empty catalog hashes to the frozen empty-set ETag", () => {
  assert.equal(
    etagOf([]).etag,
    '"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"',
  );
});
