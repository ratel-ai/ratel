import { withRequestLog } from "@/lib/platform/request-log";
import { handleListRunners } from "@/lib/views/sandboxes/run-api";
import { sandboxRunApiDeps } from "@/lib/views/sandboxes/run-api-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The project's `ratel sandbox dev` runners and their manifests (RC-1100). 404 while cloud-sandboxes is off. */
export const GET = withRequestLog(
  async (_request: Request, context: { params: Promise<{ projectId: string }> }) => {
    const { projectId } = await context.params;
    return handleListRunners(projectId, sandboxRunApiDeps);
  },
);
