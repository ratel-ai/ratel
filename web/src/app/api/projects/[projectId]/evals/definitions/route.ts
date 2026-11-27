import { withRequestLog } from "@/lib/platform/request-log";
import { evalsApiDeps } from "@/lib/views/evals/console-deps";
import { handleCreateEval } from "@/lib/views/evals/evals-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/evals/definitions: a new eval with its first version. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) =>
    handleCreateEval(request, (await context.params).projectId, evalsApiDeps),
);
