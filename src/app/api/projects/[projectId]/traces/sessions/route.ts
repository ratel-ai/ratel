import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { traceFilterFromSearch } from "@/lib/synthesis/traces/v2/filters";
import { loadSessionListPage } from "@/lib/synthesis/traces/v2/sessions-list";
import { tracesSessionsResponse } from "@/lib/synthesis/traces-sessions/route";
import { parseSessionsFilter, SESSIONS_FILTER_PARAM } from "@/lib/synthesis/traces-sessions/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/:projectId/traces/sessions?show=all|failed&cursor=<c>:
 * the next page of the Sessions tab (RC-313), newest first, 50 rows, no
 * timeframe: the sessions-only list (RC-472, RC-503). A read; no product event.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  const params = new URL(request.url).searchParams;
  const filter = parseSessionsFilter(params.getAll(SESSIONS_FILTER_PARAM));
  const cursor = params.get("cursor");
  // RC-506: the next page keeps the property filters.
  const traces = traceFilterFromSearch(params.toString());
  const load = (id: string) => loadSessionListPage(id, { filter, cursor, traces });
  return tracesSessionsResponse(projectId, load, {
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
