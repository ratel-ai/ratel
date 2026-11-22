import { isDbConfigured } from "@/lib/platform/db/client";
import { withRequestLog } from "@/lib/platform/request-log";
import { useCaseRouteDeps } from "@/lib/views/fine-tuning/use-case-route-deps";
import { handleUseCasesRequest } from "@/lib/views/fine-tuning/use-cases-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A project's fine-tuning use cases (RC-1124): list and create. The logic is in `lib/fine-tuning/use-cases-api.ts`. */
async function handle(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  if (!isDbConfigured()) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const { projectId } = await context.params;
  return handleUseCasesRequest(request, projectId, useCaseRouteDeps);
}

export const GET = withRequestLog(handle);
export const POST = withRequestLog(handle);
