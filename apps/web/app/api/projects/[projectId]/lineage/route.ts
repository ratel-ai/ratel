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
import { lineageShowsTraces } from "@/lib/views/lineage/plan";
import { chainOf, sourceOf } from "@/lib/views/lineage/resolve";
import { lineageResponse } from "@/lib/views/lineage/route";
import type { LineageRef } from "@/lib/views/lineage/types";
import { stageSpineEnabled } from "@/lib/views/stage-spine-flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = getLogger("lineage/route");

/**
 * GET /api/projects/:projectId/lineage?kind=insight&id=<id>[&chain=1]: where an
 * object came from, one step back (`source`), or the whole way back to
 * Monitor (`chain`), as `LineageRef`s (RC-45). Read by an issue's panel when
 * it opens. Behind `FF_STAGE_SPINE`. A read; no product event. Owned (ADR-0030):
 * the project comes from the console scope.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  const url = new URL(request.url);
  return lineageResponse(
    projectId,
    {
      kind: url.searchParams.get("kind"),
      id: url.searchParams.get("id"),
      chain: url.searchParams.get("chain") === "1",
    },
    {
      enabled: async () => stageSpineEnabled(),
      dbConfigured: isDbConfigured,
      getSession: async () => {
        const session = await getSessionContext();
        return session ? { userId: session.user.id } : null;
      },
      findProject: async (id) => {
        const scope = await findProjectScope(id);
        if (!scope) return null;
        // A plan without example turns does not open the run behind an insight either.
        return {
          projectId: scope.project.id,
          organizationId: scope.organization.id,
          traces: lineageShowsTraces(scope.organization),
        };
      },
      resolve: (ref, ctx, chain) =>
        withStatementTimeout<LineageRef | LineageRef[] | null>(
          (db) => (chain ? chainOf(ref, { ...ctx, db }) : sourceOf(ref, { ...ctx, db })),
          { operation: "lineage_resolve", timeoutMs: supplementaryReadTimeoutMs() },
        ),
      setLogContext: (fields) => setRequestLogContext(request, fields),
      logError: (fields, message) => logger.error(fields, message),
      reportException: reportServerException,
    },
  );
}
