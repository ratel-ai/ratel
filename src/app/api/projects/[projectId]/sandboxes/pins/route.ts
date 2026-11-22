import { withRequestLog } from "@/lib/platform/request-log";
import { handleListPins, handlePinFake, handleUnpinFake } from "@/lib/views/sandboxes/run-api";
import { sandboxRunApiDeps } from "@/lib/views/sandboxes/run-api-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pin a fake tool value in the caller's own playground session (RC-1108). 404 while cloud-sandboxes is off. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) => {
    const { projectId } = await context.params;
    return handlePinFake(request, projectId, sandboxRunApiDeps);
  },
);

/** The pins of the caller's own session (RC-1168). */
export const GET = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) => {
    const { projectId } = await context.params;
    return handleListPins(request, projectId, sandboxRunApiDeps);
  },
);

/** Remove one pin of the caller's own session (RC-1168). */
export const DELETE = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) => {
    const { projectId } = await context.params;
    return handleUnpinFake(request, projectId, sandboxRunApiDeps);
  },
);
