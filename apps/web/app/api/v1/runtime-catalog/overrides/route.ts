import {
  listRuntimeCatalogOverrides,
  touchRuntimeCatalogOverridesPull,
} from "@/lib/ingest/runtime-catalog/override-queries";
import {
  handleRuntimeCatalogOverridesGet,
  type RuntimeCatalogOverridesGetDeps,
} from "@/lib/ingest/runtime-catalog/overrides-get-handler";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";

export const runtime = "nodejs";

const deps: RuntimeCatalogOverridesGetDeps = {
  scope: BEARER_ROUTE_SCOPES["GET /api/v1/runtime-catalog/overrides"],
  resolveProjectFromBearer,
  getOrganizationByProjectId,
  listRuntimeCatalogOverrides,
  touchRuntimeCatalogOverridesPull,
  setRequestLogContext,
};

export const GET = withRequestLog((request: Request) =>
  handleRuntimeCatalogOverridesGet(request, deps),
);
