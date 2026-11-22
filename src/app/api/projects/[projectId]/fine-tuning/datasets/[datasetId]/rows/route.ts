import { isDbConfigured } from "@/lib/platform/db/client";
import { withRequestLog } from "@/lib/platform/request-log";
import { handleDatasetRowsRequest } from "@/lib/views/fine-tuning/review-api";
import { reviewRouteDeps } from "@/lib/views/fine-tuning/review-route-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A dataset version's rows, a page at a time (RC-1130). The logic is in `lib/fine-tuning/review-api.ts`. */
async function handle(
  request: Request,
  context: { params: Promise<{ projectId: string; datasetId: string }> },
): Promise<Response> {
  if (!isDbConfigured()) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const { projectId, datasetId } = await context.params;
  return handleDatasetRowsRequest(request, projectId, datasetId, reviewRouteDeps);
}

export const GET = withRequestLog(handle);
