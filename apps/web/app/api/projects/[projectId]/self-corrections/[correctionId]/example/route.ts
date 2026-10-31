import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  exampleResponse,
  loadExampleRow,
  loadReplyMessages,
} from "@/lib/views/health/self-corrections/example";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = getLogger("self-corrections/example-route");

/**
 * One self-correction's words, read back from content capture on demand, for a member of its
 * project. A read; no product event. Owned (ADR-0030): the project comes from the console scope.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(
  request: Request,
  context: { params: Promise<{ projectId: string; correctionId: string }> },
): Promise<Response> {
  const params = await context.params;
  if (!isDbConfigured()) {
    return Response.json({ ok: false, message: "This example isn't available." }, { status: 404 });
  }
  return exampleResponse(params, {
    getSession: async () => {
      const session = await getSessionContext();
      return session ? { userId: session.user.id, externalId: session.user.externalId } : null;
    },
    // One organization per session: the project must be one of its projects.
    findProject: async (projectId) => {
      const scope = await findProjectScope(projectId);
      return scope ? { projectId: scope.project.id, organizationId: scope.organization.id } : null;
    },
    loadExample: (projectId, correctionId) =>
      withStatementTimeout(
        async (db) => {
          const row = await loadExampleRow(db, projectId, correctionId);
          const reply = row?.sourceEventId
            ? await loadReplyMessages(db, projectId, row.sourceEventId)
            : null;
          return { row, reply };
        },
        { operation: "self_correction_example" },
      ),
    setLogContext: (fields) => setRequestLogContext(request, fields),
    logError: (fields, message) => logger.error(fields, message),
    reportException: reportServerException,
  });
}
