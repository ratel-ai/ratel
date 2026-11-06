import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { getLogger } from "@/lib/platform/logger";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  issueExamplesResponse,
  readIssueExamples,
  turnsPerIssue,
} from "@/lib/views/health/issue-examples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = getLogger("trace-signals/issue-examples-route");

/**
 * An issue's example turns, read on demand when a member opens the issue on Agent health's
 * Summary (`?issues=<id>,<id>`, one row's members). A read; no product event. Owned (ADR-0030):
 * the project comes from the console scope.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  if (!isDbConfigured()) {
    return Response.json(
      { ok: false, message: "These examples aren't available." },
      { status: 404 },
    );
  }
  return issueExamplesResponse(projectId, new URL(request.url).searchParams.get("issues"), {
    getSession: async () => {
      const session = await getSessionContext();
      return session ? { userId: session.user.id, externalId: session.user.externalId } : null;
    },
    // One organization per session: the project must be one of its projects.
    findProject: async (id) => {
      const scope = await findProjectScope(id);
      if (!scope) return null;
      const limits = getAgentHealthLimits(scope.organization);
      return {
        projectId: scope.project.id,
        organizationId: scope.organization.id,
        limits: {
          perIssue: turnsPerIssue(limits.agentHealthEvidenceTurns),
          shown: limits.agentHealthSignalsShown,
        },
      };
    },
    loadExamples: (id, ids, limits) =>
      withStatementTimeout((db) => readIssueExamples(db, id, ids, limits), {
        operation: "agent_health_issue_examples",
      }),
    setLogContext: (fields) => setRequestLogContext(request, fields),
    logError: (fields, message) => logger.error(fields, message),
    reportException: reportServerException,
  });
}
