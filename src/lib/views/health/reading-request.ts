import { scheduleProjectDrain as scheduleProjectDrainFn } from "@/lib/jobs/route-helpers";
import { enqueueBuildTraceTurnsJob as enqueueBuildTraceTurnsJobFn } from "@/lib/ledger/turns/queries";
import { getLogger } from "@/lib/platform/logger";
import {
  reportServerException as reportServerExceptionFn,
  trackServerEvent as trackServerEventFn,
} from "@/lib/platform/telemetry";
import type { RunTrigger } from "@/lib/readings/trace-signals/signals/queries";
import { READING_REQUEST_COOLDOWN_MS } from "@/lib/views/health/page-state";

/**
 * The page's own request for a reading, when it is about to say one is being
 * built and nothing is on its way (`readingRequestDue`): runs that closed
 * after the latest reading, an import from before imported runs closed at
 * once, or a reading that started while turns were still being built. The
 * request rides on a build (coalesced like every build): the build folds
 * unbuilt events and closes idle turns, and once it has caught up it
 * enqueues the run, so the run reads all of them. Drained after the
 * response. Never throws: the daily sweep is the backstop.
 *
 * The cooldown in `readingRequestDue` is timed by the latest run row; a run
 * that ends before it writes one (an error on its first read) would leave
 * nothing to time it by, so this process also remembers when it last asked
 * for each project, claimed before it asks (two renders at once ask once)
 * and kept when the ask fails (a page polling every few seconds does not
 * retry and re-report it each time), and asks at most once per cooldown.
 */

const logger = getLogger("trace-signals/reading-request");
const DISTINCT_ID = "system:agent-health";
/** Past this many remembered projects, the expired ones are forgotten. */
const RECENT_LIMIT = 1_000;

export interface ReadingRequestDeps {
  /** A build that asks for a run with `reading` once it has caught up. */
  enqueueBuild: (projectId: string, reading: RunTrigger) => Promise<{ id: string } | null>;
  scheduleDrain: (projectId: string) => void;
  trackServerEvent: typeof trackServerEventFn;
  reportServerException: typeof reportServerExceptionFn;
  now: () => Date;
  /** When this process last asked, by project (epoch ms). */
  recent: Map<string, number>;
}

const defaultDeps: ReadingRequestDeps = {
  enqueueBuild: (projectId, reading) =>
    enqueueBuildTraceTurnsJobFn(projectId, undefined, { reading }),
  scheduleDrain: (projectId) => scheduleProjectDrainFn(projectId),
  trackServerEvent: trackServerEventFn,
  reportServerException: reportServerExceptionFn,
  now: () => new Date(),
  recent: new Map(),
};

function forgetExpired(recent: Map<string, number>, at: number): void {
  if (recent.size <= RECENT_LIMIT) return;
  for (const [projectId, askedAt] of recent) {
    if (at - askedAt >= READING_REQUEST_COOLDOWN_MS) recent.delete(projectId);
  }
}

/** True when the reading is queued (or already was); false when the request was throttled or failed. */
export async function requestHealthReading(
  input: { projectId: string; organizationId: string; reason: string },
  overrides: Partial<ReadingRequestDeps> = {},
): Promise<boolean> {
  const deps = { ...defaultDeps, ...overrides };
  const { projectId } = input;
  const at = deps.now().getTime();
  const askedAt = deps.recent.get(projectId);
  if (askedAt !== undefined && at - askedAt < READING_REQUEST_COOLDOWN_MS) {
    logger.info(
      { project_id: projectId, reason: input.reason },
      "agent health reading request throttled",
    );
    return false;
  }
  // Claimed before the first await: a second render in this process now waits its turn.
  deps.recent.set(projectId, at);
  forgetExpired(deps.recent, at);
  try {
    const build = await deps.enqueueBuild(projectId, "manual");
    deps.scheduleDrain(projectId);
    const fields = { build_queued: build !== null, reason: input.reason };
    logger.info({ project_id: projectId, ...fields }, "agent health reading requested");
    await deps.trackServerEvent(
      "trace_signal_run_requested",
      { distinctId: DISTINCT_ID, projectId, orgId: input.organizationId },
      {
        object_action: "trace_signal_run_requested",
        trigger: "manual",
        source: "health_page",
        ...fields,
      },
    );
    return true;
  } catch (err) {
    logger.error(
      { err, project_id: projectId, reason: input.reason },
      "agent health reading request failed",
    );
    deps.reportServerException(err, `project:${projectId}`, {
      project_id: projectId,
      operation: "agent_health_reading_request",
    });
    return false;
  }
}
