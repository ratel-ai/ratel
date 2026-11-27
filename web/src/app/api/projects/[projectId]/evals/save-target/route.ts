import { withRequestLog } from "@/lib/platform/request-log";
import { handleSaveOptions } from "@/lib/views/evals/cases-api";
import { casesApiDeps } from "@/lib/views/evals/console-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/[projectId]/evals/save-target?turnId=|traceId=&task=: the tasks of a turn or a
 * trace, the default task, and the target eval of each task, for "Save as eval case".
 */
export const GET = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) =>
    handleSaveOptions(request, (await context.params).projectId, casesApiDeps),
);
