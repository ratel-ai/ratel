import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { reportServerException } from "@/lib/platform/telemetry";
import { evalGateEnabledFor } from "@/lib/views/eval-gate/gate";
import { badgeOf } from "@/lib/views/eval-gate/service";
import { getEvalSet, listEvalRuns, liveRun } from "@/lib/views/eval-gate/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = getLogger("eval-gate/status-route");
const FIX_ID = /^(rewrite|craft|issue|intent):[^\s]{1,200}$/;

/**
 * A fix's eval gate badge (`?fix=<fix id>`), read by the eval page while a
 * simulation runs so it can refresh when it lands. A read; no product event.
 * Behind `FF_EVAL_GATE`: off reads as not found. Owned (ADR-0030): the project
 * comes from the console scope.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  const fixId = new URL(request.url).searchParams.get("fix") ?? "";
  if (!isDbConfigured() || !FIX_ID.test(fixId))
    return json(404, { ok: false, message: "This eval isn't available." });
  const scope = await findProjectScope(projectId);
  if (!scope || !(await evalGateEnabledFor(scope.organization)))
    return json(404, { ok: false, message: "This eval isn't available." });
  setRequestLogContext(request, {
    project_id: scope.project.id,
    org_id: scope.organization.id,
    distinct_id: scope.user.externalId,
  });
  try {
    const set = await getEvalSet(scope.project.id, fixId);
    if (!set) return json(200, { ok: true, badge: { state: "none" } });
    const run = (await liveRun(set.id)) ?? (await listEvalRuns(set.id, 1))[0] ?? null;
    return json(200, { ok: true, badge: badgeOf(set, run) });
  } catch (err) {
    logger.error({ err, project_id: scope.project.id }, "fix eval status read failed");
    reportServerException(err, scope.user.externalId, {
      operation: "fix_eval_status",
      project_id: scope.project.id,
    });
    return json(500, { ok: false, message: "Couldn't read this eval. Try again in a moment." });
  }
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
