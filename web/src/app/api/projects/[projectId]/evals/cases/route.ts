import { withRequestLog } from "@/lib/platform/request-log";
import { handleCreateCase } from "@/lib/views/evals/cases-api";
import { casesApiDeps } from "@/lib/views/evals/console-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/evals/cases: a case from a turn, or from what a person typed. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) =>
    handleCreateCase(request, (await context.params).projectId, casesApiDeps),
);
