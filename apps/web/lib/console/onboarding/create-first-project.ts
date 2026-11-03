import type { ActingAs } from "@/lib/contracts/session";
import type { GeneratedApiKey } from "@/lib/platform/api-keys";
import {
  billableProjectCount,
  type OrgLimitView,
  type QuotaResult,
} from "@/lib/platform/entitlements";
import { slugify } from "@/lib/platform/organization";
import type { trackProductEvent } from "@/lib/platform/telemetry";

/**
 * The first-project step of onboarding: a name becomes a project and its first API key in one
 * go, and the key's plaintext comes back once for the reveal. Upstream keeps this inside the
 * server action; here it sits behind injected dependencies so the refusals (a support session,
 * the plan's cap, a stale session) are tested without a database or the composition.
 */

export type CreateProjectState =
  | null
  | { ok: false; error: string }
  | {
      ok: true;
      id: string;
      name: string;
      slug: string;
      apiKey: string;
      /** Whether the key reveal shows "What Ratel will read" and the content-capture opt-in. */
      showCaptureConsent: boolean;
    };

/** Upstream's refusal text for a support session: a time-boxed session must not mint credentials. */
export const SUPPORT_SESSION_RESTRICTED_MESSAGE =
  "Not available during an admin support session. End the session first.";

export type FirstProjectSession = {
  user: { externalId: string };
  organization: OrgLimitView & { slug: string };
};

export type CreateFirstProjectDeps = {
  /** Whether a database is connected; checked after the name, as upstream does. */
  dbConfigured: () => boolean;
  /** The session, null when signed out. */
  session: () => Promise<FirstProjectSession | null>;
  /** The session port's support session; any value refuses the write. */
  actingAs: () => Promise<ActingAs>;
  listProjects: (organizationId: string) => Promise<{ slug: string; isDemo?: boolean | null }[]>;
  createProject: (input: { organizationId: string; name: string; slug: string }) => Promise<{
    id: string;
    name: string;
    slug: string;
  }>;
  createApiKey: (input: {
    projectId: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
  }) => Promise<unknown>;
  generateApiKey: () => GeneratedApiKey;
  checkQuota: (organization: OrgLimitView, key: "maxProjects", currentCount: number) => QuotaResult;
  track: typeof trackProductEvent;
};

/** Ensure the slug is unique within the account's projects (append -2, -3, …). */
function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function createFirstProject(
  input: { name: string; organizationId?: string },
  deps: CreateFirstProjectDeps,
): Promise<CreateProjectState> {
  const name = input.name.trim();
  if (name.length < 2) {
    return { ok: false, error: "Give your agent a name (at least 2 characters)." };
  }
  if (name.length > 60) {
    return { ok: false, error: "Name is too long (max 60 characters)." };
  }
  if (!deps.dbConfigured()) {
    return {
      ok: false,
      error: "The database isn't connected yet. Please try again shortly.",
    };
  }
  if (await deps.actingAs()) {
    return { ok: false, error: SUPPORT_SESSION_RESTRICTED_MESSAGE };
  }

  const session = await deps.session();
  if (!session) {
    return { ok: false, error: "Your session has expired. Sign in again." };
  }
  const organization = session.organization;
  if (input.organizationId && input.organizationId !== organization.id) {
    return { ok: false, error: "Organization not found." };
  }
  const actor = { externalId: session.user.externalId, orgId: organization.id };

  const base = slugify(name) || "agent";
  const existing = await deps.listProjects(organization.id);

  // Enforce the plan's project cap through the entitlements port (unlimited in this edition).
  const quota = deps.checkQuota(organization, "maxProjects", billableProjectCount(existing));
  if (!quota.ok) {
    await deps.track("quota_limit_hit", actor, { limit: "maxProjects", cap: quota.limit });
    return { ok: false, error: quota.message };
  }

  const taken = new Set(existing.map((p) => p.slug));
  const slug = uniqueSlug(base, taken);

  const project = await deps.createProject({ organizationId: organization.id, name, slug });
  await deps.track(
    "project_created",
    { ...actor, projectId: project.id },
    { project_slug: project.slug },
  );

  // Keys are stored as hash and prefix only; the plaintext exists in this response and nowhere else.
  const key = deps.generateApiKey();
  await deps.createApiKey({
    projectId: project.id,
    name: "Default",
    keyHash: key.hash,
    keyPrefix: key.prefix,
  });
  await deps.track(
    "api_key_created",
    { ...actor, projectId: project.id },
    { key_prefix: key.prefix, named: true, expires_in: "never" },
  );

  // Agent health is on for every project in this edition, so the reveal always explains what is read.
  return {
    ok: true,
    id: project.id,
    name: project.name,
    slug: project.slug,
    apiKey: key.plaintext,
    showCaptureConsent: true,
  };
}
