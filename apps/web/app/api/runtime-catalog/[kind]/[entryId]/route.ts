import { resolveProjectById } from "@/lib/catalog/http";
import {
  handleRuntimeCatalogOverridePatch,
  type RuntimeCatalogOverridePatchDeps,
} from "@/lib/ingest/runtime-catalog/override-handler";
import { setRuntimeCatalogOverride } from "@/lib/ingest/runtime-catalog/override-queries";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { trackServerEvent } from "@/lib/platform/telemetry";

export const runtime = "nodejs";

const deps: RuntimeCatalogOverridePatchDeps = {
  resolveProjectById,
  getOrganizationByProjectId,
  setRuntimeCatalogOverride,
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
