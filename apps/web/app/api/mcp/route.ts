import { createMcpRouteHandler, methodNotAllowed } from "@/lib/mcp/route-handler";
import { withRequestLog } from "@/lib/platform/request-log";

/**
 * The Ratel Cloud MCP endpoint: `POST https://cloud.ratel.sh/api/mcp`.
 *
 * Stateless Streamable HTTP. One POST carries one JSON-RPC message (or a small
 * batch) and gets one JSON response back; no session id is issued and no SSE
 * stream is opened. That is a deployment constraint, not a simplification: the
 * service runs behind an ALB with no session affinity and deploys by rolling
 * tasks, so a session pinned to one task would break on every release.
 *
 * The native BM25 addon and node:crypto both need the Node runtime.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = withRequestLog(createMcpRouteHandler());
export const GET = withRequestLog(async () => methodNotAllowed());
export const DELETE = withRequestLog(async () => methodNotAllowed());
