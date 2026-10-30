import { normalizeOrganizationSettings, type OrgRole } from "@/lib/platform/organization";

export type UpdateOrganizationResult =
  | { ok: true; name: string; slug: string }
  | { ok: false; error: string };

export type UpdateOrganizationDeps = {
  /** The session organization and the reader's role in it; null without a session. */
  scope: () => Promise<{ organization: { id: string; slug: string }; role: OrgRole } | null>;
  update: (
    organizationId: string,
    values: { name: string; slug: string },
  ) => Promise<{ ok: true } | { ok: false; reason: "slug_conflict" }>;
};

/** Renames the session organization and its address; admins only. */
export async function updateConsoleOrganization(
  organizationSlug: string,
  input: { name: string; slug: string },
  deps: UpdateOrganizationDeps,
): Promise<UpdateOrganizationResult> {
  const scope = await deps.scope();
  if (!scope || scope.organization.slug !== organizationSlug) {
    return { ok: false, error: "Organization not found." };
  }
  if (scope.role !== "admin") {
    return { ok: false, error: "Only organization admins can change these." };
  }
  const normalized = normalizeOrganizationSettings(input);
  if (!normalized.ok) return normalized;
  const written = await deps.update(scope.organization.id, {
    name: normalized.name,
    slug: normalized.slug,
  });
  if (!written.ok) return { ok: false, error: "That address is taken. Pick another one." };
  return normalized;
}
