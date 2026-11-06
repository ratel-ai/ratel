import { createHash } from "node:crypto";

/** Frozen protocol/v2 projection. Unset overrides canonicalize to JSON null. */
export const SKILL_FIELDS = [
  "id",
  "name",
  "description",
  "searchableDescription",
  "tags",
  "tools",
  "metadata",
  "body",
] as const;

export interface WireSkill {
  id: string;
  name: string;
  description: string;
  searchableDescription?: string | null;
  tags: string[];
  tools: string[];
  metadata: Record<string, string[]>;
  body: string;
}

export interface Catalog {
  global: WireSkill[];
  subjects?: Record<string, WireSkill[]>;
}

export interface CatalogResponse {
  catalogVersion: string;
  skills: WireSkill[];
}

export function canonicalSkill(skill: WireSkill): string {
  const stringify = JSON.stringify;
  const metadataKeys = Object.keys(skill.metadata ?? {}).sort(byteCompare);
  const metadata =
    "{" +
    metadataKeys.map((key) => `${stringify(key)}:${stringify(skill.metadata[key])}`).join(",") +
    "}";
  return (
    "{" +
    `"id":${stringify(skill.id)}` +
    `,"name":${stringify(skill.name)}` +
    `,"description":${stringify(skill.description)}` +
    `,"searchableDescription":${stringify(skill.searchableDescription ?? null)}` +
    `,"tags":${stringify(skill.tags)}` +
    `,"tools":${stringify(skill.tools)}` +
    `,"metadata":${metadata}` +
    `,"body":${stringify(skill.body)}` +
    "}"
  );
}

export function canonicalSet(skills: WireSkill[]): string {
  return `[${sortById(skills).map(canonicalSkill).join(",")}]`;
}

export function etagOf(skills: WireSkill[]): { hex: string; etag: string } {
  const hex = createHash("sha256").update(canonicalSet(skills), "utf8").digest("hex");
  return { hex, etag: `"${hex}"` };
}

export function resolve(catalog: Catalog, scope: string | null | undefined): WireSkill[] {
  const global = catalog.global ?? [];
  if (scope == null) return sortById(global);
  const byName = new Map<string, WireSkill>();
  for (const skill of global) byName.set(skill.name, skill);
  for (const skill of (catalog.subjects ?? {})[scope] ?? []) byName.set(skill.name, skill);
  return sortById([...byName.values()]);
}

export function ifNoneMatchMatches(
  headerValue: string | null | undefined,
  currentEtag: string,
): boolean {
  if (headerValue == null) return false;
  const value = headerValue.trim();
  if (value === "*") return true;
  const current = opaque(currentEtag);
  return value.split(",").some((token) => {
    const candidate = opaque(token);
    return candidate.length > 0 && candidate === current;
  });
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function sortById(skills: WireSkill[]): WireSkill[] {
  return [...skills].sort((a, b) => byteCompare(a.id, b.id));
}

function opaque(tag: string): string {
  let value = tag.trim();
  if (value.startsWith("W/")) value = value.slice(2).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return value;
}
