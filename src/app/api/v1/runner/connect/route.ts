import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { handleRunnerConnect } from "@/lib/views/sandboxes/connect";

export const runtime = "nodejs";

/**
 * POST /api/v1/runner/connect — a `ratel sandbox dev` runner trades its project key
 * for `{ gatewayUrl, token, expiresAt }`: a 15-minute socket token bound to the
 * project and the key's creator. 404 while cloud-sandboxes is off for the key's
 * organization. See lib/sandboxes/connect.ts.
 */
export const POST = withRequestLog((req: Request) =>
  handleRunnerConnect(req, BEARER_ROUTE_SCOPES["POST /api/v1/runner/connect"]),
);
