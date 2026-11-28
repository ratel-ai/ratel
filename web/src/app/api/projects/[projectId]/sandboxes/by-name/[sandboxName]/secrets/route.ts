import { withRequestLog } from "@/lib/platform/request-log";
import { secretsApiDeps } from "@/lib/views/sandboxes/console-deps";
import { handleListSandboxSecrets } from "@/lib/views/sandboxes/secrets-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ projectId: string; sandboxName: string }> };

/**
 * GET /api/projects/[projectId]/sandboxes/by-name/[sandboxName]/secrets: each declared name with
 * its source (sandbox, project or missing), never a value.
 */
export const GET = withRequestLog(async (_request: Request, context: Context) => {
  const { projectId, sandboxName } = await context.params;
  return handleListSandboxSecrets(projectId, sandboxName, secretsApiDeps);
});
