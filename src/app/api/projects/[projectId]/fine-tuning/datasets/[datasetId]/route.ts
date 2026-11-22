import { isDbConfigured } from "@/lib/platform/db/client";
import { withRequestLog } from "@/lib/platform/request-log";
import {
  handleDatasetDeleteRequest,
  handleDatasetGetRequest,
} from "@/lib/views/fine-tuning/export-api";
import { exportRouteDeps } from "@/lib/views/fine-tuning/review-route-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ projectId: string; datasetId: string }> };

/**
 * Read one dataset version's view, never row text (RC-1178), or delete it, its
 * rows and its lineage link (RC-1131). The logic is in `lib/fine-tuning/export-api.ts`.
 */
async function read(_request: Request, context: Context): Promise<Response> {
  if (!isDbConfigured()) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const { projectId, datasetId } = await context.params;
  return handleDatasetGetRequest(projectId, datasetId, exportRouteDeps);
}

async function remove(_request: Request, context: Context): Promise<Response> {
  if (!isDbConfigured()) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const { projectId, datasetId } = await context.params;
  return handleDatasetDeleteRequest(projectId, datasetId, exportRouteDeps);
}

export const GET = withRequestLog(read);
export const DELETE = withRequestLog(remove);
