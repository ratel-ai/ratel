import type { TracesEmptyKind } from "@/components/console/traces/TracesEmpty";
import { TracesUnavailable } from "@/components/console/traces/TracesUnavailable";
import {
  type RunningSearchExperiment,
  SessionsView,
} from "@/components/console/traces-sessions/SessionsView";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { createExperimentService } from "@/lib/synthesis/experiments/service";
import type { ExperimentSummary } from "@/lib/synthesis/experiments/types";
import { calibrationDetailPath } from "@/lib/synthesis/traces/calibration-view";
import { createExperimentQueries } from "@/lib/synthesis/traces/experiment-queries";
import { selectExperimentBanner } from "@/lib/synthesis/traces/experiment-view";
import { payloadContentEnabledForActor } from "@/lib/synthesis/traces/payload-content";
import { getTracesIngestDiagnostics } from "@/lib/synthesis/traces/queries";
import { loadSessionsPage } from "@/lib/synthesis/traces-sessions/sessions";
import { parseSessionsFilter, SESSIONS_FILTER_PARAM } from "@/lib/synthesis/traces-sessions/view";

const DAY_MS = 86_400_000;
/** How far back a search experiment counts as running for the rows' label. */
const EXPERIMENT_DAYS = 7;

/**
 * The Sessions tab (`FF_TRACES_SESSIONS`, RC-313): the first page of the
 * list, newest first, under All or Failed. There is no timeframe here: the
 * summary header above the tabs holds it, and further pages load as the
 * person scrolls (`/api/projects/:id/traces/sessions`).
 */
export async function SessionsPage({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: { [SESSIONS_FILTER_PARAM]?: string | string[] };
}) {
  if (!isDbConfigured()) return <TracesUnavailable />;
  // Checked here too, as upstream does: the list shows each session's ask.
  const { project } = await requireProjectScope(projectId);

  const filter = parseSessionsFilter(searchParams[SESSIONS_FILTER_PARAM]);
  const askFromPayload = await payloadContentEnabledForActor(
    project.id,
    `project:${project.id}`,
  ).catch(() => false);
  const now = new Date();
  const window = { since: new Date(now.getTime() - EXPERIMENT_DAYS * DAY_MS), until: now };
  const [page, experiments] = await Promise.all([
    loadSessionsPage(project.id, { filter, askFromPayload }),
    loadOrFallback({
      operation: "trace_experiments",
      distinctId: `project:${project.id}`,
      fallback: [] as ExperimentSummary[],
      load: () =>
        withStatementTimeout(
          (db) =>
            createExperimentService(createExperimentQueries(db)).listExperiments(
              project.id,
              window,
            ),
          {
            operation: "trace_experiments",
            timeoutMs: supplementaryReadTimeoutMs(),
          },
        ),
    }),
  ]);

  let empty: TracesEmptyKind | "no-failed" | null = null;
  if (page.items.length === 0) {
    if (filter === "failed") empty = "no-failed";
    else {
      const diagnostics = await getTracesIngestDiagnostics(project.id);
      empty = diagnostics.hasEvents && !diagnostics.hasSpans ? "events-only" : "no-telemetry";
    }
  }
  const running = selectExperimentBanner(experiments, "");
  const experiment: RunningSearchExperiment | null = running
    ? {
        name: running.name,
        href: calibrationDetailPath(`/project/${project.id}/calibration`, running.name),
      }
    : null;

  return (
    <SessionsView
      projectId={project.id}
      filter={filter}
      rows={page.items}
      nextCursor={page.nextCursor}
      empty={empty}
      experiment={experiment}
    />
  );
}
