import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { requestBuildDeps } from "@/lib/views/fine-tuning/build-route-deps";
import { type DatasetsApiDeps, handleDatasetsRequest } from "@/lib/views/fine-tuning/datasets-api";
import { fineTuningEnabled } from "@/lib/views/fine-tuning/flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A use case's dataset versions (RC-1128): list and build. The logic is in `lib/fine-tuning/datasets-api.ts`. */
const deps: DatasetsApiDeps = {
  getSession: getSessionContext,
  findProjectScope,
  fineTuningEnabled: (organization) => fineTuningEnabled(organization),
  isRestricted: isRestrictedBySupportSession,
  build: () => requestBuildDeps(getDb()),
};

async function handle(
  request: Request,
  context: { params: Promise<{ projectId: string; useCaseId: string }> },
): Promise<Response> {
  if (!isDbConfigured()) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const { projectId, useCaseId } = await context.params;
  return handleDatasetsRequest(request, projectId, useCaseId, deps);
}

export const GET = withRequestLog(handle);
export const POST = withRequestLog(handle);
