import { withRequestLog } from "@/lib/platform/request-log";
import { evalDialogDeps } from "@/lib/views/evals/console-deps";
import { handleCreateEvalFromDialog } from "@/lib/views/evals/eval-dialog-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/evals: creates an eval from the "New eval" dialog. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) =>
    handleCreateEvalFromDialog(request, (await context.params).projectId, evalDialogDeps),
);
