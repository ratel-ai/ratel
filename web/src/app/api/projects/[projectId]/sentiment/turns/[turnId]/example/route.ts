import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException } from "@/lib/platform/telemetry";
import { sentimentAnalysisEnabled } from "@/lib/readings/trace-signals/outcomes/gate";
import { loadTurnExample, sentimentExampleResponse } from "@/lib/views/traces/sentiment/example";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = getLogger("sentiment/example-route");

/**
 * One example turn of a Sentiment analysis row: the request, what the agent
 * ran, the errors, the reply and the next message, read on demand for a member
 * of the project and never stored. Behind `cloud-sentiment-analysis`. A read;
 * no product event. Owned (ADR-0004): the project comes from the console scope,
 * and the switch is the core's `sentimentAnalysis`.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(
  request: Request,
  context: { params: Promise<{ projectId: string; turnId: string }> },
): Promise<Response> {
  const params = await context.params;
  if (!isDbConfigured()) {
    return Response.json({ ok: false, message: "This example isn't available." }, { status: 404 });
  }
  return sentimentExampleResponse(params, {
    getSession: async () => {
      const session = await getSessionContext();
      return session ? { userId: session.user.id, externalId: session.user.externalId } : null;
    },
    // One organization per session: the project must be one of its projects.
    findProject: async (projectId) => {
      const scope = await findProjectScope(projectId);
      if (!scope) return null;
      const enabled = await sentimentAnalysisEnabled(scope.organization).catch(() => false);
      return { projectId: scope.project.id, organizationId: scope.organization.id, enabled };
    },
    loadExample: (projectId, turnId) =>
      withStatementTimeout((db) => loadTurnExample(db, projectId, turnId), {
        operation: "sentiment_example",
      }),
    setLogContext: (fields) => setRequestLogContext(request, fields),
    logError: (fields, message) => logger.error(fields, message),
    reportException: reportServerException,
  });
}
