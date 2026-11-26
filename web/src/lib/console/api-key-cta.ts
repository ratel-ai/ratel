import { TRACES_DOCS } from "@/lib/console/docs-links";
import { apiKeyStatus } from "@/lib/platform/api-keys";

/**
 * The API-key call to action every "nothing sent yet" surface shares (the
 * Overview's setup guide, the Traces empty state, Agent health's states). A
 * project with a usable key is not told to create one: onboarding already
 * issued it, so the CTA points at the existing key and the next step becomes
 * sending the first trace. Only a project with no usable key is asked to
 * create one.
 *
 * Pure and serializable, so a server page decides it once and hands it to
 * client components (`ApiKeyCta`).
 */

/** The stored columns the decision reads; a `listApiKeysForProject` row fits. */
export type ApiKeyCtaRecord = {
  name: string | null;
  keyPrefix: string;
  createdAt: Date;
  revokedAt: Date | null;
  expiresAt: Date | null;
  scopes: readonly string[];
};

/** The key a "view" CTA names: never the secret, only what the key list shows. */
export type ApiKeyCtaKey = {
  name: string | null;
  keyPrefix: string;
  /** ISO timestamp. */
  createdAt: string;
  /** "Onboarding · rtl_a1b2c3d4… · created Nov 20, 2026". */
  detail: string;
};

export type ApiKeyCtaStep = { label: string; href: string };

export type ApiKeyCta =
  | { kind: "create"; label: string; href: string; key: null; next: ApiKeyCtaStep }
  | { kind: "view"; label: string; href: string; key: ApiKeyCtaKey; next: ApiKeyCtaStep };

const CREATE_LABEL = "Create an API key";
const VIEW_LABEL = "View API keys";
const FIRST_TRACE_LABEL = "Send your first trace";

const CREATED_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function apiKeysHref(projectId: string): string {
  return `/project/${encodeURIComponent(projectId)}/settings/api-keys`;
}

/** The CTA for a project with no usable key, and for a key read that failed (as before). */
export function noApiKeyCta(projectId: string): ApiKeyCta {
  const href = apiKeysHref(projectId);
  return {
    kind: "create",
    label: CREATE_LABEL,
    href,
    key: null,
    next: { label: CREATE_LABEL, href },
  };
}

/**
 * Decide the CTA from a project's keys. Revoked and expired keys do not count.
 * The key named is the one the quickstart snippets embed
 * (`getPrimaryApiKeyForProject`): a Full key before a scoped one, then newest.
 */
export function apiKeyCta(
  projectId: string,
  keys: readonly ApiKeyCtaRecord[],
  now: Date = new Date(),
): ApiKeyCta {
  const primary = keys
    .filter((key) => apiKeyStatus(key, now) === "active")
    .sort(
      (a, b) =>
        Number(isFull(b)) - Number(isFull(a)) || b.createdAt.getTime() - a.createdAt.getTime(),
    )[0];
  if (!primary) return noApiKeyCta(projectId);
  return {
    kind: "view",
    label: VIEW_LABEL,
    href: apiKeysHref(projectId),
    key: {
      name: primary.name,
      keyPrefix: primary.keyPrefix,
      createdAt: primary.createdAt.toISOString(),
      detail: [
        primary.name,
        `${primary.keyPrefix}…`,
        `created ${CREATED_DATE.format(primary.createdAt)}`,
      ]
        .filter(Boolean)
        .join(" · "),
    },
    next: { label: FIRST_TRACE_LABEL, href: TRACES_DOCS },
  };
}

function isFull(key: ApiKeyCtaRecord): boolean {
  return key.scopes.includes("*");
}
