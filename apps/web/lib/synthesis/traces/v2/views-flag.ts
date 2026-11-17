import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";

export const TRACE_VIEWS_V3_FLAG = "FF_TRACE_VIEWS_V3" as const;
/**
 * Upstream's `cloud-traces-filters` (RC-505). Upstream retires it in #416 and reads the filters
 * for everyone; here that end state lands at once, so it names no switch and reads on.
 */
export const TRACE_FILTERS_FLAG = "cloud-traces-filters" as const;

export interface TraceViewsFlagDeps {
  read: (projectId: string, actor: string) => Promise<boolean>;
  report: (message: string, err: unknown, projectId: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const logger = getLogger("traces/views-flag");

const DEFAULT_DEPS = defaultDeps(TRACE_VIEWS_V3_FLAG, async () =>
  experimentalFeatureEnabled(TRACE_VIEWS_V3_FLAG),
);
const FILTERS_DEPS = defaultDeps(TRACE_FILTERS_FLAG, async () => true);

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
  return guardedRead(projectId, actor, deps, "trace views flag read failed");
}

/**
 * Whether the Sessions and Turns property filters (RC-505) are on for whoever reads this
 * project: on for every valid project id (upstream retires its flag in #416). Read once per
 * request; off and reported on a failed read, like the views flag.
 */
export async function traceFiltersEnabledForActor(
  projectId: string,
  actor: string,
  deps: TraceViewsFlagDeps = FILTERS_DEPS,
): Promise<boolean> {
  return guardedRead(projectId, actor, deps, "trace filters flag read failed");
}

async function guardedRead(
  projectId: string,
  actor: string,
  deps: TraceViewsFlagDeps,
  failure: string,
): Promise<boolean> {
  if (!UUID.test(projectId)) return false;
  try {
    return await deps.read(projectId, actor);
  } catch (err) {
    deps.report(failure, err, projectId);
    return false;
  }
}

function defaultDeps(
  flag: typeof TRACE_VIEWS_V3_FLAG | typeof TRACE_FILTERS_FLAG,
  read: TraceViewsFlagDeps["read"],
): TraceViewsFlagDeps {
  return {
    read,
    report: (message, err, projectId) => {
      logger.error({ err, project_id: projectId, flag_key: flag }, message);
      reportServerException(err, `project:${projectId}`, {
        operation: "trace_views_flag",
        project_id: projectId,
      });
    },
  };
}
