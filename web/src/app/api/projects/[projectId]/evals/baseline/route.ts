import { withRequestLog } from "@/lib/platform/request-log";
import { handlePinByMember, handleUnpinByMember } from "@/lib/views/evals/baseline-api";
import { consoleBaselineDeps } from "@/lib/views/evals/baseline-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ projectId: string }> };

/** PUT /api/projects/[projectId]/evals/baseline: a member pins a completed experiment. */
export const PUT = withRequestLog(async (request: Request, context: Context) =>
  handlePinByMember(request, (await context.params).projectId, consoleBaselineDeps),
);

/** DELETE /api/projects/[projectId]/evals/baseline: a member removes the pin. */
export const DELETE = withRequestLog(async (_request: Request, context: Context) =>
  handleUnpinByMember((await context.params).projectId, consoleBaselineDeps),
);
