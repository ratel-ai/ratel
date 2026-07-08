/**
 * The frozen protocol/v1 content projection and ETag algorithm
 * (`protocol/v1/README.md`, pinned by `protocol/v1/conformance/vectors.json`).
 * Reimplemented here — the reference verifier is not importable — and pinned
 * against the committed vectors in `canonical.test.ts`. Changing any byte of
 * this serialization is a protocol v2.
 */

import { createHash } from "node:crypto";

/** The wire shape of one skill in a v1 catalog pull (`catalog-skill.schema.json`). */
export interface CatalogSkillWire {
  id: string;
  name: string;
  description: string;
  tags: string[];
  tools: string[];
  metadata: Record<string, string[]>;
  body: string;
}

/**
 * Anything projectable to the wire shape: the SDK `Skill` (optional fields) and
 * any raw source-side object carrying extra fields the projection drops.
 */
export interface SkillLike {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  tools?: string[];
  metadata?: Record<string, string[]>;
  body?: string;
}

/** Source-side layers a scope resolves against: one global set plus per-subject overlays. */
export interface SourceLayers {
  global: CatalogSkillWire[];
  subjects?: Record<string, CatalogSkillWire[]>;
}

// UTF-8 bytewise comparison, for the set sort-by-id and the metadata key sort.
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Project a skill to exactly the 7 wire fields, defaulting the SDK's optional ones. */
export function projectSkill(skill: SkillLike): CatalogSkillWire {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.tags ?? [],
    tools: skill.tools ?? [],
    metadata: skill.metadata ?? {},
    body: skill.body ?? "",
  };
}

/**
 * Canonical JSON for one projected skill: the 7 keys in fixed order, metadata
 * keys byte-sorted, arrays in authored order, minimal escaping, raw UTF-8, no
 * whitespace. `JSON.stringify` on strings/arrays already emits minimal escapes
 * and raw UTF-8; key order is driven by hand so object iteration order can
 * never influence the bytes.
 */
export function canonicalSkill(skill: SkillLike): string {
  const p = projectSkill(skill);
  const s = JSON.stringify;
  const metaKeys = Object.keys(p.metadata).sort(byteCompare);
  const meta = `{${metaKeys.map((k) => `${s(k)}:${s(p.metadata[k])}`).join(",")}}`;
  return (
    `{"id":${s(p.id)},"name":${s(p.name)},"description":${s(p.description)},` +
    `"tags":${s(p.tags)},"tools":${s(p.tools)},"metadata":${meta},"body":${s(p.body)}}`
  );
}

/** Canonical bytes for a resolved set: skills sorted by id, compact JSON array. */
export function canonicalSet(skills: SkillLike[]): string {
  const sorted = [...skills].sort((a, b) => byteCompare(a.id, b.id));
  return `[${sorted.map(canonicalSkill).join(",")}]`;
}

/** ETag over a resolved set: lowercase hex sha256 plus the quoted strong tag. */
export function etagOf(skills: SkillLike[]): { hex: string; etag: string } {
  const hex = createHash("sha256").update(canonicalSet(skills), "utf8").digest("hex");
  return { hex, etag: `"${hex}"` };
}

/**
 * Resolve the published set for a scope: absent scope or unknown subject means
 * the global layer only; a known subject overlays its layer on the global one,
 * the subject winning on `name` collision (the merge key is name, not id).
 * The merged set is re-sorted by id.
 */
export function resolveScope(layers: SourceLayers, scope?: string | null): CatalogSkillWire[] {
  const global = layers.global ?? [];
  const sortById = (skills: CatalogSkillWire[]) =>
    [...skills].sort((a, b) => byteCompare(a.id, b.id));
  if (scope == null) return sortById(global);
  const subject = layers.subjects?.[scope] ?? [];
  const byName = new Map<string, CatalogSkillWire>();
  for (const sk of global) byName.set(sk.name, sk);
  for (const sk of subject) byName.set(sk.name, sk);
  return sortById([...byName.values()]);
}

/** True when two skills agree on exactly the 7 wire fields — the sync idempotence gate. */
export function skillsEqual(a: SkillLike, b: SkillLike): boolean {
  return canonicalSkill(a) === canonicalSkill(b);
}
