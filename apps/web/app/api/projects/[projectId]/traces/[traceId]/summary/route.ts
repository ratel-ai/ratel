import { findProject } from "@/lib/console/navigation";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException } from "@/lib/platform/telemetry";
import { getTraceSpansWithTruncation } from "@/lib/synthesis/traces/queries";
import { runSummaryResponse } from "@/lib/synthesis/traces/v2/run-summary-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = getLogger("traces/run-summary-route");

/** The v2 run Panel: one run as a conversation, for a member of its project. A read; no product event. */
export const GET = withRequestLog(handleGet);

async function handleGet(
  request: Request,
  context: { params: Promise<{ projectId: string; traceId: string }> },
): Promise<Response> {
  const params = await context.params;
  if (!isDbConfigured()) {
    return Response.json({ ok: false, message: "This run isn't available." }, { status: 404 });
  }
  const session = await getSessionContext();
  return runSummaryResponse(params, {
    getSession: async () =>
      session ? { userId: session.user.id, externalId: session.user.externalId } : null,
    // One organization per session: the project must be one of its projects.
    findProject: async (projectId) => {
      if (!session) return null;
      const projects = await listProjectsForOrganization(session.organization.id);
      return findProject(projects, projectId)
        ? { projectId, organizationId: session.organization.id }
        : null;
    },
    loadSpans: (projectId, traceId) =>
      withStatementTimeout((db) => getTraceSpansWithTruncation(projectId, traceId, db), {
        operation: "trace_run_summary",
      }),
    setLogContext: (fields) => setRequestLogContext(request, fields),
    logError: (fields, message) => logger.error(fields, message),
    reportException: reportServerException,
    aborted: () => request.signal.aborted,
  });
}
