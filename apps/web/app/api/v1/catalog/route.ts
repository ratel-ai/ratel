import { handleCatalogRequest } from "@/lib/catalog/pull-route-handler";
import {
  getProjectCatalogVersion,
  getPublishedCatalog,
  listPublishedSkillRowsForScope,
  setProjectCatalogVersion,
  toCatalogWire,
} from "@/lib/catalog/queries";
import type { Catalog, WireSkill } from "@/lib/catalog/wire";
import { hashApiKey } from "@/lib/platform/api-keys";
import { isDbConfigured } from "@/lib/platform/db/client";
import { findActiveApiKeyByHash, touchApiKey } from "@/lib/platform/projects/queries";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";

// node:crypto for the ETag SHA-256 + key hashing — keep off the edge runtime.
export const runtime = "nodejs";

/**
 * GET /api/v1/catalog[?scope=<end-user>] — the `protocol/v1` catalog-source
 * pull-sync (ADR-0003). Bearer-authenticated; returns the project's published
 * skills as `WireSkill[]` under a conditional-GET ETag. A global pull answers 304
 * from the stored `projects.catalog_version` without loading the catalog; a scoped
 * pull (`?scope=`) serves global + that end-user's own skills, ETag'd on the fly
 * (byte-identical to `/v1/intents/analyze`'s `catalogVersion` for the same scope).
 *
 * The request logic lives in `handleCatalogRequest` with its dependencies
 * injected so it is unit-testable without a database; here we wire in the real
 * ones. `next.config.ts` rewrites `/v1/catalog` → this route to match the
 * contract's `/v1/*` path convention.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(req: Request) {
  return handleCatalogRequest(req, {
    isDbConfigured,
    hashApiKey,
    findActiveApiKeyByHash,
    touchApiKey,
    getProjectCatalogVersion,
    getPublishedCatalog,
    setProjectCatalogVersion,
    // Two-layer catalog for `?scope=<end-user>`: partition the scoped published rows
    // into the global layer + that user's subject layer (resolve() shadows global).
    getScopedCatalog: async (projectId, endUserId) => {
      const rows = await listPublishedSkillRowsForScope(projectId, endUserId);
      const catalog: Catalog = { global: [], subjects: {} };
      for (const row of rows) {
        const wire = toCatalogWire(row);
        if (row.endUserId === null) {
          catalog.global.push(wire);
          continue;
        }
        const subjects = catalog.subjects as Record<string, WireSkill[]>;
        let bucket = subjects[row.endUserId];
        if (!bucket) {
          bucket = [];
          subjects[row.endUserId] = bucket;
        }
        bucket.push(wire);
      }
      return catalog;
    },
    setRequestLogContext,
  });
}
