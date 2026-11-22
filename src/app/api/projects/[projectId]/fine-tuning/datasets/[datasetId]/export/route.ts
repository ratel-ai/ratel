import { isDbConfigured } from "@/lib/platform/db/client";
import { withRequestLog } from "@/lib/platform/request-log";
import { handleDatasetExportRequest } from "@/lib/views/fine-tuning/export-api";
import { exportRouteDeps } from "@/lib/views/fine-tuning/review-route-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One side of a dataset version as JSONL, streamed (RC-1131). The logic is in `lib/fine-tuning/export-api.ts`. */
async function handle(
  request: Request,
  context: { params: Promise<{ projectId: string; datasetId: string }> },
): Promise<Response> {
  if (!isDbConfigured()) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const { projectId, datasetId } = await context.params;
  return handleDatasetExportRequest(request, projectId, datasetId, exportRouteDeps);
}

export const GET = withRequestLog(handle);
