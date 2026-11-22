import { isDbConfigured } from "@/lib/platform/db/client";
import { withRequestLog } from "@/lib/platform/request-log";
import { sessionPanelChatResponse } from "@/lib/views/session-chat/panel-route";
import { panelRouteDeps } from "@/lib/views/session-chat/panel-route-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Sessions tab's side panel: the whole session as chat (lib/session-chat/panel-route.ts). A read; no product event. */
export const GET = withRequestLog(handleGet);

async function handleGet(
  request: Request,
  context: { params: Promise<{ projectId: string; sessionId: string }> },
): Promise<Response> {
  const params = await context.params;
  if (!isDbConfigured()) return Response.json({ ok: false, error: "Not found." }, { status: 404 });
  return sessionPanelChatResponse(params, panelRouteDeps(request));
}
