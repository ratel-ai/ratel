import { isDbConfigured } from "@/lib/platform/db/client";
import { withRequestLog } from "@/lib/platform/request-log";
import { useCaseRouteDeps } from "@/lib/views/fine-tuning/use-case-route-deps";
import { handleUseCaseRequest } from "@/lib/views/fine-tuning/use-cases-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One fine-tuning use case (RC-1124): read, update and archive. The logic is in `lib/fine-tuning/use-cases-api.ts`. */
async function handle(
  request: Request,
  context: { params: Promise<{ projectId: string; useCaseId: string }> },
): Promise<Response> {
  if (!isDbConfigured()) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const { projectId, useCaseId } = await context.params;
  return handleUseCaseRequest(request, projectId, useCaseId, useCaseRouteDeps);
}

export const GET = withRequestLog(handle);
export const PATCH = withRequestLog(handle);
export const DELETE = withRequestLog(handle);
