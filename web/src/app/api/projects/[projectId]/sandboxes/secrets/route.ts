import { withRequestLog } from "@/lib/platform/request-log";
import { secretsApiDeps } from "@/lib/views/sandboxes/console-deps";
import { handleListSecrets } from "@/lib/views/sandboxes/secrets-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/projects/[projectId]/sandboxes/secrets: the names, never a value. */
export const GET = withRequestLog(
  async (_request: Request, context: { params: Promise<{ projectId: string }> }) =>
    handleListSecrets((await context.params).projectId, secretsApiDeps),
);
