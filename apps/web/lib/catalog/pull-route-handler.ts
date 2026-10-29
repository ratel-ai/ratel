import type {
  getProjectCatalogVersion as getProjectCatalogVersionFn,
  getPublishedCatalog as getPublishedCatalogFn,
  setProjectCatalogVersion as setProjectCatalogVersionFn,
} from "@/lib/catalog/queries";
import { type Catalog, etagOf, ifNoneMatchMatches, resolve } from "@/lib/catalog/wire";
import type { hashApiKey as hashApiKeyFn } from "@/lib/platform/api-keys";
import type { isDbConfigured as isDbConfiguredFn } from "@/lib/platform/db/client";
import type {
  findActiveApiKeyByHash as findActiveApiKeyByHashFn,
  touchApiKey as touchApiKeyFn,
} from "@/lib/platform/projects/queries";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";

/**
 * `GET /v1/catalog` — the `protocol/v1` catalog-source pull-sync (ADR-0003).
 * Mirrors the OTLP handler: Bearer auth + injected dependencies so
 * the contract is unit-testable without a database. Serves the authenticated
 * project's published skills as `WireSkill[]` under a conditional-GET ETag; the
 * byte-exact ETag/resolve logic lives in `./wire`.
 *
 * Two ETag reads by design ("stored content-hash"):
 *  - the cheap **304 fast-path** compares `If-None-Match` against the stored
 *    `projects.catalog_version` (one column read; never loads the catalog);
 *  - the **200 path** hashes the freshly-loaded published set, so the body and its
 *    ETag are always mutually consistent even if the stored value momentarily lags a
 *    mutation. Under normal operation the two are equal (every set-changing mutation
 *    recomputes and stores the hash), so the fast-path is correct; the only residual
 *    is a sub-request-long window during a mutation, identical to a version counter.
 *    When the freshly computed hash disagrees with the stored one (a concurrent-
 *    mutation race left it stale — `recomputeCatalogVersion` is a non-atomic
 *    read-then-write on neon-http), the 200 path **self-heals** the stored value.
 *
 * Scope: `?scope=<subject>` serves the global layer PLUS that end-user's own
 * published skills (subject shadows global by name). Global pulls use the cheap
 * stored-version (`projects.catalog_version`) 304 fast-path; scoped pulls
 * content-address their ETag on the fly (the stored value tracks only the global
 * layer, so it is neither read nor healed for a scoped request — doing so would
 * corrupt the global fast-path). The scoped `resolve()`+`etagOf()` is byte-identical
 * to the analyze pipeline's, so a scoped `catalogVersion` here equals
 * `analyze(scope)`'s.
 */

export interface CatalogHandlerDeps {
  isDbConfigured: typeof isDbConfiguredFn;
  hashApiKey: typeof hashApiKeyFn;
  findActiveApiKeyByHash: typeof findActiveApiKeyByHashFn;
  touchApiKey: typeof touchApiKeyFn;
  /** The stored ETag hex (`projects.catalog_version`); null before the first publish. */
  getProjectCatalogVersion: typeof getProjectCatalogVersionFn;
  /** The project's published, global skills in wire shape (sorted by name = id). */
  getPublishedCatalog: typeof getPublishedCatalogFn;
  /** Self-heal hook: persist the authoritative ETag hex when it differs from the
   * stored one (converges a stored value that a concurrent-mutation race left stale). */
  setProjectCatalogVersion: typeof setProjectCatalogVersionFn;
  /** The published skills for a subject scope as a two-layer {@link Catalog} — the
   * global layer plus that end-user's own rows — for `?scope=<subject>` serving. */
  getScopedCatalog: (projectId: string, endUserId: string) => Promise<Catalog>;
  /** Stamp the project onto this request's CloudWatch log line; no-op when absent. */
  setRequestLogContext?: typeof setRequestLogContextFn;
}

/** v1 error code → HTTP status. */
const ERROR_STATUS = {
  unauthorized: 401,
  not_found: 404,
  invalid_request: 400,
  unavailable: 503,
} as const;
type ErrorCode = keyof typeof ERROR_STATUS;

/** The uniform `protocol/v1` error body. */
function fail(code: ErrorCode, message: string): Response {
  return Response.json({ error: { code, message } }, { status: ERROR_STATUS[code] });
}

/** The frozen empty-set ETag — what a project reports before its first publish. */
const EMPTY_SET = etagOf([]);

export async function handleCatalogRequest(
  req: Request,
  deps: CatalogHandlerDeps,
): Promise<Response> {
  // 1. Authenticate via the project API key (no DB needed to reject a missing key).
  const authz = req.headers.get("authorization") ?? "";
  const match = authz.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return fail("unauthorized", "Missing or malformed Authorization: Bearer <key>.");
  }

  if (!deps.isDbConfigured()) {
    return fail("unavailable", "Catalog is not available. Database not configured.");
  }

  const apiKey = await deps.findActiveApiKeyByHash(deps.hashApiKey(match[1].trim()));
  if (!apiKey) {
    return fail("unauthorized", "Invalid or revoked API key.");
  }
  deps.setRequestLogContext?.(req, { project_id: apiKey.projectId });

  // Parse the optional subject scope once (empty/whitespace ⇒ global).
  const scope = new URL(req.url).searchParams.get("scope")?.trim() || null;
  const inm = req.headers.get("if-none-match");

  // 2a. Subject-scoped pull (`?scope=<end-user>`): the global layer PLUS that user's
  // own published skills, content-addressing the ETag on the fly. The stored
  // projects.catalog_version tracks only the GLOBAL layer, so it is deliberately
  // neither used for the fast-path nor healed here (a scoped hash must never clobber
  // the global one). Byte-identical resolve()+etagOf() to the analyze pipeline, so a
  // scoped catalogVersion here equals analyze(scope)'s.
  if (scope !== null) {
    const catalog = await deps.getScopedCatalog(apiKey.projectId, scope);
    const resolved = resolve(catalog, scope);
    const { hex, etag } = etagOf(resolved);
    await deps.touchApiKey(apiKey.id).catch(() => {});
    const headers = { ETag: etag, "Cache-Control": "no-cache" };
    if (ifNoneMatchMatches(inm, etag)) return new Response(null, { status: 304, headers });
    return Response.json({ catalogVersion: hex, skills: resolved }, { headers });
  }

  // 2b. Global pull — cheap 304 fast-path: compare If-None-Match against the stored
  // catalog version without loading the catalog. Null stored value = never published
  // → the frozen empty-set tag.
  const stored = await deps.getProjectCatalogVersion(apiKey.projectId);
  const storedEtag = stored ? `"${stored}"` : EMPTY_SET.etag;
  if (ifNoneMatchMatches(inm, storedEtag)) {
    await deps.touchApiKey(apiKey.id).catch(() => {});
    return new Response(null, {
      status: 304,
      headers: { ETag: storedEtag, "Cache-Control": "no-cache" },
    });
  }

  // 3. Full read: hash the freshly-loaded published set (authoritative ETag). When
  // the stored value disagrees — a concurrent-mutation race left it stale — heal it
  // so the 304 fast-path converges back to correct rather than serving a wrong 304 to
  // clients whose cached tag matches the stale stored value.
  const published = await deps.getPublishedCatalog(apiKey.projectId);
  const resolved = resolve({ global: published }, null);
  const { hex, etag } = etagOf(resolved);
  if (hex !== stored) {
    await deps.setProjectCatalogVersion(apiKey.projectId, hex).catch(() => {});
  }

  // Best-effort heartbeat; must never turn a successful read into an error.
  await deps.touchApiKey(apiKey.id).catch(() => {});

  const headers = { ETag: etag, "Cache-Control": "no-cache" };

  // 4. Conditional GET against the authoritative tag (covers a stale stored value
  // whose fresh hash still matches the client's cache).
  if (ifNoneMatchMatches(inm, etag)) {
    return new Response(null, { status: 304, headers });
  }

  return Response.json({ catalogVersion: hex, skills: resolved }, { headers });
}
