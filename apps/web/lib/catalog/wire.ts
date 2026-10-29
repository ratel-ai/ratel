/**
 * The `protocol/v1` catalog-source wire shapes and the frozen ETag algorithm.
 *
 * This is a faithful TypeScript port of the reference verifier
 * (`protocol/v1/conformance/verify.mjs` in the `ratel` repo). The text spec in
 * `protocol/v1/README.md` is normative; this module reproduces it so Cloud can
 * serve a conforming `GET /v1/catalog`. Its conformance is pinned by
 * `wire.test.ts`, which runs the committed vectors (`__fixtures__/catalog-vectors.json`,
 * a vendored copy of the protocol's `vectors.json`) byte-for-byte.
 *
 * Anything that changes the bytes here — field set, order, canonicalization,
 * the resolve/overlay rule — is a breaking protocol change (a `/v2` event), not
 * a local refactor. Keep it in lockstep with the source of truth.
 */

import { createHash } from "node:crypto";

/** The frozen v1 content projection: exactly these fields, in this order. */
export const SKILL_FIELDS = [
  "id",
  "name",
  "description",
  "tags",
  "tools",
  "metadata",
  "body",
] as const;

/** One skill as it crosses the wire (`CatalogSkillWire`). */
export interface WireSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  tools: string[];
  metadata: Record<string, string[]>;
  body: string;
}

/** The source-side catalog for a project: a global layer + optional subject layers. */
export interface Catalog {
  global: WireSkill[];
  subjects?: Record<string, WireSkill[]>;
}

/** The `GET /v1/catalog` 200 body (`CatalogResponse`). */
export interface CatalogResponse {
  catalogVersion: string;
  skills: WireSkill[];
}

/**
 * UTF-8 bytewise comparison (== Unicode code-point order for the ASCII ids/keys
 * the contract uses). Drives the set sort-by-id and the metadata key sort.
 */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Canonical JSON for one projected skill: fixed field order, metadata keys
 * byte-sorted, arrays in authored order, minimal JSON escaping, raw UTF-8, no
 * insignificant whitespace. `JSON.stringify` on a string / string[] already
 * emits minimal escapes + raw UTF-8 + compact form; field and metadata-key
 * order are driven by hand so object-key iteration order never influences bytes.
 */
export function canonicalSkill(skill: WireSkill): string {
  const s = JSON.stringify;
  const metaKeys = Object.keys(skill.metadata ?? {}).sort(byteCompare);
  const meta = "{" + metaKeys.map((k) => s(k) + ":" + s(skill.metadata[k])).join(",") + "}";
  return (
    "{" +
    '"id":' +
    s(skill.id) +
    ',"name":' +
    s(skill.name) +
    ',"description":' +
    s(skill.description) +
    ',"tags":' +
    s(skill.tags) +
    ',"tools":' +
    s(skill.tools) +
    ',"metadata":' +
    meta +
    ',"body":' +
    s(skill.body) +
    "}"
  );
}

function sortById(skills: WireSkill[]): WireSkill[] {
  return [...skills].sort((a, b) => byteCompare(a.id, b.id));
}

/**
 * Canonical bytes for a resolved set: skills sorted by id, each canonicalized,
 * joined as a compact JSON array.
 */
export function canonicalSet(skills: WireSkill[]): string {
  return "[" + sortById(skills).map(canonicalSkill).join(",") + "]";
}

/**
 * ETag over a resolved set: lowercase hex SHA-256 of the canonical bytes,
 * wrapped as a strong entity-tag. `hex` is the body's `catalogVersion`; `etag`
 * is the quoted `ETag` header value.
 */
export function etagOf(skills: WireSkill[]): { hex: string; etag: string } {
  const hex = createHash("sha256").update(canonicalSet(skills), "utf8").digest("hex");
  return { hex, etag: '"' + hex + '"' };
}

/**
 * Resolve the published set for a scope: absent scope ⇒ global layer; a named
 * subject ⇒ its layer overlaid on the global layer, subject winning on `name`
 * collision; an unknown subject ⇒ the global layer (empty overlay). Result is
 * sorted by id.
 */
export function resolve(catalog: Catalog, scope: string | null | undefined): WireSkill[] {
  const global = catalog.global ?? [];
  if (scope == null) return sortById(global);
  const layer = (catalog.subjects ?? {})[scope] ?? [];
  const byName = new Map<string, WireSkill>();
  for (const sk of global) byName.set(sk.name, sk);
  for (const sk of layer) byName.set(sk.name, sk); // subject wins on name collision
  return sortById([...byName.values()]);
}

/** Strip a `W/` weak prefix and surrounding quotes to the opaque tag value. */
function opaque(tag: string): string {
  let t = tag.trim();
  if (t.startsWith("W/")) t = t.slice(2).trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  return t;
}

/**
 * `If-None-Match` matcher (weak comparison, per RFC 7232 §3.2). Returns true
 * when the request is a cache hit (⇒ 304). `*` matches any current
 * representation. Comma-list tokens are compared by opaque value.
 */
export function ifNoneMatchMatches(
  headerValue: string | null | undefined,
  currentEtag: string,
): boolean {
  if (headerValue == null) return false;
  const v = headerValue.trim();
  if (v === "*") return true;
  const current = opaque(currentEtag);
  return v.split(",").some((tok) => {
    const o = opaque(tok);
    return o.length > 0 && o === current;
  });
}

/**
 * `If-Match` precondition (strong comparison, per RFC 7232 §3.1). Returns true
 * when the write may proceed. An absent header passes: the precondition only
 * applies when the client asserts one. `*` passes whenever a representation
 * exists, which is the caller's case by the time it asks. A weak (`W/`) tag
 * never satisfies a strong comparison.
 */
export function ifMatchMatches(
  headerValue: string | null | undefined,
  currentEtag: string,
): boolean {
  if (headerValue == null) return true;
  const v = headerValue.trim();
  if (v === "*") return true;
  const current = opaque(currentEtag);
  return v.split(",").some((tok) => {
    const t = tok.trim();
    if (t.startsWith("W/")) return false;
    const o = opaque(t);
    return o.length > 0 && o === current;
  });
}
