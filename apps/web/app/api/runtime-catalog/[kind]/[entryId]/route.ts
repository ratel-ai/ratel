import { resolveProjectById } from "@/lib/catalog/http";
import {
  handleRuntimeCatalogOverridePatch,
  type RuntimeCatalogOverrideHandlerDeps,
} from "@/lib/ingest/runtime-catalog/override-handler";
import {
  listRuntimeCatalogOverrides,
  setRuntimeCatalogOverride,
  touchRuntimeCatalogOverridesPull,
} from "@/lib/ingest/runtime-catalog/override-queries";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { trackServerEvent } from "@/lib/platform/telemetry";

export const runtime = "nodejs";

const deps: RuntimeCatalogOverrideHandlerDeps = {
  resolveProjectById,
  resolveProjectFromBearer,
  getOrganizationByProjectId,
  setRuntimeCatalogOverride,
  listRuntimeCatalogOverrides,
  touchRuntimeCatalogOverridesPull,
  setRequestLogContext,
  trackServerEvent,
};

export const PATCH = withRequestLog(handlePatch);

async function handlePatch(
  request: Request,
  context: { params: Promise<{ kind: string; entryId: string }> },
): Promise<Response> {
  return handleRuntimeCatalogOverridePatch(request, await context.params, deps);
}
