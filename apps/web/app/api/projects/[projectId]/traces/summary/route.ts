import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { tracesSessionsResponse } from "@/lib/synthesis/traces-sessions/route";
import { loadTabSummary } from "@/lib/synthesis/traces-sessions/summary";
import {
  parseTracesTab,
  parseTracesWindow,
  TRACES_WINDOW_PARAM,
} from "@/lib/synthesis/traces-sessions/timeframe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/:projectId/traces/summary?tab=sessions|spans|logs&window=24h|7d|30d:
 * the summary inside one Traces tab (RC-312, RC-331), in that tab's unit.
 * A slow aggregate answers
 * `status: "unavailable"`, not an error. A read; no product event.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  const query = new URL(request.url).searchParams;
  const window = parseTracesWindow(query.getAll(TRACES_WINDOW_PARAM));
  const tab = parseTracesTab(query.getAll("tab"));
  return tracesSessionsResponse(projectId, (id) => loadTabSummary(id, tab, window), {
    dbConfigured: isDbConfigured,
    getSession: async () => {
      const session = await getSessionContext();
      return session ? { userId: session.user.id } : null;
    },
    // One organization per session: the project must be one of its projects.
    findProject: async (id) => {
      const scope = await findProjectScope(id);
      return scope ? { projectId: scope.project.id, organizationId: scope.organization.id } : null;
    },
    setLogContext: (fields) => setRequestLogContext(request, fields),
  });
}
