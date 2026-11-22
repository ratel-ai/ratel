/**
 * Organization membership primitives shared across the app: the role model and a
 * tiny permission helper. Kept dependency-free so it can be imported from server
 * actions, pages, and the ingest layer alike.
 */

/** A member's role within an organization. Admins manage members + invite codes. */
export type OrgRole = "admin" | "member";
export type NormalizedOrganizationSettings =
  | { ok: true; name: string; slug: string }
  | { ok: false; error: string };

export const ORG_ROLES: readonly OrgRole[] = ["admin", "member"] as const;
export const ORG_NAME_MAX_LEN = 60;
export const ORG_SLUG_MAX_LEN = 48;

/** Narrow an untrusted string (DB column / form value) to a valid role. */
export function isOrgRole(value: unknown): value is OrgRole {
  return value === "admin" || value === "member";
}

/** Coerce a possibly-null DB role to a concrete role (defaults to member). */
export function toRole(value: string | null | undefined): OrgRole {
  return value === "admin" ? "admin" : "member";
}

export function isAdmin(role: string | null | undefined): boolean {
  return toRole(role) === "admin";
}

/** Normalize and validate the editable organization settings. */
export function normalizeOrganizationSettings(input: {
  name: string;
  slug: string;
}): NormalizedOrganizationSettings {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Organization name can't be empty." };
  if (name.length > ORG_NAME_MAX_LEN) {
    return {
      ok: false,
      error: `Organization name must be ${ORG_NAME_MAX_LEN} characters or fewer.`,
    };
  }

  const slug = slugify(input.slug);
  if (!slug) {
    return {
      ok: false,
      error: "Organization slug must include a letter or number.",
    };
  }
  return { ok: true, name, slug };
}

/** URL-safe slug from an arbitrary name, or "" if nothing usable. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ORG_SLUG_MAX_LEN);
}
