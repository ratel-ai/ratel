import { handleCatalogV2Request } from "@/lib/catalog/pull-route-handler-v2";
import {
  getProjectCatalogVersionV2,
  getPublishedCatalogV2,
  listPublishedSkillRowsForScope,
  setProjectCatalogVersionV2,
  toCatalogWireV2,
} from "@/lib/catalog/queries";
import type { Catalog, WireSkill } from "@/lib/catalog/wire-v2";
import { hashApiKey } from "@/lib/platform/api-keys";
import { isDbConfigured } from "@/lib/platform/db/client";
import { findActiveApiKeyByHash, touchApiKey } from "@/lib/platform/projects/queries";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";

export const runtime = "nodejs";

export const GET = withRequestLog(handleGet);

async function handleGet(req: Request): Promise<Response> {
  return handleCatalogV2Request(req, {
    isDbConfigured,
    hashApiKey,
    findActiveApiKeyByHash,
    touchApiKey,
    getProjectCatalogVersionV2,
    getPublishedCatalogV2,
    setProjectCatalogVersionV2,
    getScopedCatalogV2: async (projectId, endUserId) => {
      const rows = await listPublishedSkillRowsForScope(projectId, endUserId);
      const catalog: Catalog = { global: [], subjects: {} };
      for (const row of rows) {
        const wire = toCatalogWireV2(row);
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
