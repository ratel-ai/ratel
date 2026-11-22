import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException } from "@/lib/platform/telemetry";
import { shipMonitorEnabledFor } from "@/lib/views/ship-monitor/gate";
import { loadShipmentWatches } from "@/lib/views/ship-monitor/load";
import { watchResponse } from "@/lib/views/ship-monitor/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = getLogger("ship-monitor/route");

/**
 * GET /api/projects/:projectId/ship/watch[?shipment=<id>]: how the newest
 * shipped fixes behave live (`lib/ship-monitor`), read every few seconds by
 * Ship's watch cards. A read; no product event. Owned (ADR-0030): the
 * project comes from the console scope, which takes the project id only.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  const shipmentId = new URL(request.url).searchParams.get("shipment") ?? undefined;
  return watchResponse(
    projectId,
    { shipmentId },
    {
      dbConfigured: isDbConfigured,
      getSession: async () => {
        const session = await getSessionContext();
        return session ? { userId: session.user.id } : null;
      },
      findProject: async (id) => {
        const scope = await findProjectScope(id);
        if (!scope) return null;
        return {
          projectId: scope.project.id,
          organizationId: scope.organization.id,
          enabled: await shipMonitorEnabledFor(scope.organization),
        };
      },
      loadWatches: (id, options) =>
        withStatementTimeout((db) => loadShipmentWatches(id, options, db), {
          operation: "ship_watch",
          timeoutMs: supplementaryReadTimeoutMs(),
        }),
      now: () => new Date(),
      setLogContext: (fields) => setRequestLogContext(request, fields),
      logError: (fields, message) => logger.error(fields, message),
      reportException: reportServerException,
    },
  );
}
