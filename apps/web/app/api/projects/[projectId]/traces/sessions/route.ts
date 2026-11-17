import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { traceFilterFromSearch } from "@/lib/synthesis/traces/v2/filters";
import { loadSessionListPage } from "@/lib/synthesis/traces/v2/sessions-list";
import {
  traceFiltersEnabledForActor,
  traceViewsV3EnabledForActor,
} from "@/lib/synthesis/traces/v2/views-flag";
import { tracesSessionsResponse } from "@/lib/synthesis/traces-sessions/route";
import { loadSessionsPage } from "@/lib/synthesis/traces-sessions/sessions";
import { parseSessionsFilter, SESSIONS_FILTER_PARAM } from "@/lib/synthesis/traces-sessions/view";
import { tracesSessionsEnabled } from "@/lib/synthesis/traces-sessions-flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/:projectId/traces/sessions?show=all|failed&cursor=<c>:
 * the next page of the Sessions tab (RC-313), newest first, 50 rows, no
 * timeframe. Behind `FF_TRACES_SESSIONS`, or `FF_TRACE_VIEWS_V3` (RC-472),
 * which reads the sessions-only list (RC-503). A read; no product event.
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
  let viewsV3: boolean | null = null;
  const v3 = async () => {
    if (viewsV3 === null) {
      const session = await getSessionContext();
      viewsV3 = session
        ? await traceViewsV3EnabledForActor(projectId, session.user.externalId)
        : false;
    }
    return viewsV3;
  };
  // RC-506: with `cloud-traces-filters` the next page keeps the property filters.
  const traces = async (id: string) => {
    const session = await getSessionContext();
    return session && (await traceFiltersEnabledForActor(id, session.user.externalId))
      ? traceFilterFromSearch(params.toString())
      : undefined;
  };
  const load = async (id: string) =>
    (await v3())
      ? loadSessionListPage(id, { filter, cursor, traces: await traces(id) })
      : loadSessionsPage(id, { filter, cursor });
  return tracesSessionsResponse(projectId, load, {
    // RC-472: the Sessions tab of the v3 views pages through the same list.
    enabled: async () => (await v3()) || tracesSessionsEnabled(),
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
