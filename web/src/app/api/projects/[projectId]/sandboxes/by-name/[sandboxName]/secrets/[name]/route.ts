import { withRequestLog } from "@/lib/platform/request-log";
import { secretsApiDeps } from "@/lib/views/sandboxes/console-deps";
import {
  handleRemoveSandboxSecret,
  handleSetSandboxSecret,
} from "@/lib/views/sandboxes/secrets-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ projectId: string; sandboxName: string; name: string }> };

/** Sets the value of one secret for one sandbox. It wins over the project value. */
export const PUT = withRequestLog(async (request: Request, context: Context) => {
  const { projectId, sandboxName, name } = await context.params;
  return handleSetSandboxSecret(request, projectId, sandboxName, name, secretsApiDeps);
});

/** Removes the sandbox value. The project value, when there is one, applies again. */
export const DELETE = withRequestLog(async (_request: Request, context: Context) => {
  const { projectId, sandboxName, name } = await context.params;
  return handleRemoveSandboxSecret(projectId, sandboxName, name, secretsApiDeps);
});
