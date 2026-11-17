import type { ApiKeyKind } from "@/lib/platform/api-keys";
import {
  type ApiKeyAccess,
  type ApiKeyScope,
  apiKeyAccess,
  hasScope,
  isPublishableScopes,
} from "@/lib/platform/api-keys/scopes";

/**
 * The one place that decides what an API key may do (RC-585).
 *
 * Every permission check in the app asks the policy built here from a key's
 * stored scopes: the bearer routes (through `authenticateApiKey`), each MCP
 * tool, captured content, the shared-key rate limits and what ingest may write.
 * No other module reads a scope list directly (`policy.test.ts` fails if one
 * does), so changing what a kind of key may do is a change to this file, and
 * every surface follows.
 *
 * Two inputs feed it: the scopes a key holds (`scopes.ts`) and, separately,
 * the scope each surface needs (`routes.ts`). This file joins them.
 */
export interface ApiKeyPolicy {
  /** The stored scopes the policy was built from. */
  readonly scopes: readonly string[];
  /** Whether the key may use a surface that needs `scope`. */
  allows(scope: ApiKeyScope): boolean;
  /** Whether the key may use a surface that needs any one of `scopes` (MCP). */
  allowsAny(scopes: readonly ApiKeyScope[]): boolean;
  /** Which preset the scopes match, for the dashboard. */
  readonly access: ApiKeyAccess;
  /**
   * Only ingest: the one kind safe to ship inside an app, so anyone may hold
   * it. Everything below follows from this.
   */
  readonly publishable: boolean;
  /** `rtl_pub_` for a publishable key, `rtl_` otherwise. A label, never trusted. */
  readonly kind: ApiKeyKind;
  /** Charged against the shared per-key and per-source budgets (`ingest-limits.ts`). */
  readonly sharedKeyLimits: boolean;
  /**
   * Ingest may only add rows (RC-590): never delete or replace a stored row,
   * never open a source's facts era (which would hide that source's other
   * telemetry), never write the runtime's latest-wins ranking status.
   */
  readonly appendOnlyIngest: boolean;
}

export function apiKeyPolicy(scopes: readonly string[] | null | undefined): ApiKeyPolicy {
  // A row without scopes grants nothing: fail closed.
  const held: readonly string[] = scopes ?? [];
  const publishable = isPublishableScopes(held);
  const allows = (scope: ApiKeyScope) => hasScope(held, scope);
  return {
    scopes: held,
    allows,
    allowsAny: (candidates) => candidates.some(allows),
    access: apiKeyAccess(held),
    publishable,
    kind: publishable ? "publishable" : "secret",
    sharedKeyLimits: publishable,
    appendOnlyIngest: publishable,
  };
}
