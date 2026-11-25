import { withRequestLog } from "@/lib/platform/request-log";
import { secretsApiDeps } from "@/lib/views/sandboxes/console-deps";
import { handleRemoveSecret, handleSetSecret } from "@/lib/views/sandboxes/secrets-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ projectId: string; name: string }> };

/** Sets one secret. The answer has its name only. */
export const PUT = withRequestLog(async (request: Request, context: Context) => {
  const { projectId, name } = await context.params;
  return handleSetSecret(request, projectId, name, secretsApiDeps);
});

export const DELETE = withRequestLog(async (_request: Request, context: Context) => {
  const { projectId, name } = await context.params;
  return handleRemoveSecret(projectId, name, secretsApiDeps);
});
