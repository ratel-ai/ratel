import { withRequestLog } from "@/lib/platform/request-log";
import { handleCreateEvalByMember } from "@/lib/views/evals/console-api";
import { consoleApiDeps } from "@/lib/views/evals/experiment-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/evals/definitions: an eval from the "New eval" dialog. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) =>
    handleCreateEvalByMember(request, (await context.params).projectId, consoleApiDeps),
);
