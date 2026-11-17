import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";

export const TRACE_VIEWS_V3_FLAG = "FF_TRACE_VIEWS_V3" as const;

export interface TraceViewsFlagDeps {
  read: (projectId: string, actor: string) => Promise<boolean>;
  report: (message: string, err: unknown, projectId: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const logger = getLogger("traces/views-flag");

const DEFAULT_DEPS: TraceViewsFlagDeps = {
  read: async () => experimentalFeatureEnabled(TRACE_VIEWS_V3_FLAG),
  report: (message, err, projectId) => {
    logger.error({ err, project_id: projectId, flag_key: TRACE_VIEWS_V3_FLAG }, message);
    reportServerException(err, `project:${projectId}`, {
      operation: "trace_views_flag",
      project_id: projectId,
    });
  },
};

/**
 * Whether the redesigned trace and session views (RC-394) are on for whoever reads this
 * project. Owned (ADR-0030): upstream decides `cloud-trace-views-v3` in the project's organization
 * through its session replay gate (a views module this layer may not import); here it is the
 * deployment switch `FF_TRACE_VIEWS_V3`, read from the platform layer. Off by default, and off for a project id that is no UUID
 * (a mistyped URL), which no project has. Every traces page reads it, with
 * the flag on or off, so a failed read is off and reported, never thrown.
 */
export async function traceViewsV3EnabledForActor(
  projectId: string,
  actor: string,
  deps: TraceViewsFlagDeps = DEFAULT_DEPS,
): Promise<boolean> {
  if (!UUID.test(projectId)) return false;
  try {
    return await deps.read(projectId, actor);
  } catch (err) {
    deps.report("trace views flag read failed", err, projectId);
    return false;
  }
}
