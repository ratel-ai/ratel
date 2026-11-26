"use server";

import { revalidatePath } from "next/cache";
import { parseProjectUuid } from "@/lib/console/scope/cookie";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import { getTraceFilterFacets, type TraceFilterFacets } from "@/lib/synthesis/traces/trace-filters";
import {
  authorizeScorers,
  changeScorer,
  type ScorerAccessDeps,
  type ScorerActionResult,
  testScorer,
} from "@/lib/views/scorers/actions";
import { parseFilter, parseTasks } from "@/lib/views/scorers/config";
import { countLastWeek, type PreviewResult, previewScorer } from "@/lib/views/scorers/preview";
import {
  attachScorer,
  countScorers,
  createScorer,
  deleteScorer,
  detachScorer,
  getScorer,
  setScorerEnabled,
} from "@/lib/views/scorers/store";
import { updateScorerWithTask } from "@/lib/views/scorers/task-presets";
import type { ScorerDraft } from "@/lib/views/scorers/types";
import { loadTaskOptions, type TaskOption } from "./tasks";

const logger = getLogger("scorers/actions");
const WEEK_MS = 7 * 86_400_000;

const access: ScorerAccessDeps = {
  getSession: getSessionContext,
  findProjectScope: (projectId) => findProjectScope(projectId),
  enabled: (subject) => featureEnabled("customMonitoring", subject),
  isRestricted: isRestrictedBySupportSession,
};

/** Create, update, switch, attach, detach or delete a scorer. */
export async function changeScorerAction(input: unknown): Promise<ScorerActionResult> {
  return guarded("scorer_change", "Could not save the scorer. Try again.", () =>
    changeScorer(input, {
      ...access,
      get: (projectId, scorerId) => getScorer(projectId, scorerId),
      count: (projectId) => countScorers(projectId),
      create: (projectId, draft, actor) => createScorer(projectId, draft, actor),
      // A scorer the system made for one task writes back to that task's scorer (the eval gate).
      update: (projectId, scorerId, draft, actor) =>
        updateScorerWithTask(projectId, scorerId, draft, actor),
      setEnabled: (projectId, scorerId, enabled, actor) =>
        setScorerEnabled(projectId, scorerId, enabled, actor),
      attach: (projectId, scorerId, taskId, actor) =>
        attachScorer(projectId, scorerId, taskId, actor),
      detach: (projectId, scorerId, taskId, actor) =>
        detachScorer(projectId, scorerId, taskId, actor),
      remove: (projectId, scorerId) => deleteScorer(projectId, scorerId),
      observe: async (fields) => {
        await trackServerEvent(
          "feature.scorers.changed",
          { externalId: fields.actor, projectId: fields.project_id, orgId: fields.organization_id },
          fields,
        );
        revalidatePath(`/project/${fields.project_id}/scorers`, "layout");
        revalidatePath(`/project/${fields.project_id}/tasks`, "layout");
      },
    }),
  );
}

/** Run a draft on the newest matching traces; no result is stored. */
export async function testScorerAction(
  projectId: string,
  draft: unknown,
): Promise<{ ok: true; results: PreviewResult[] } | { ok: false; error: string }> {
  return guarded("scorer_test", "Could not test the scorer. Try again.", () =>
    testScorer(projectId, draft, {
      ...access,
      preview: (id, parsed) => previewScorer(id, parsed),
    }),
  );
}

/** How many traces of the last 7 days a scorer takes. */
export async function countScorerTracesAction(
  projectId: string,
  rawFilter: unknown,
  rawTasks: unknown,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const filter = parseFilter(rawFilter);
  const tasks = parseTasks(rawTasks);
  if (!filter || tasks === undefined) return { ok: false, error: "The trace filter is invalid." };
  return guarded("scorer_count", "Could not count the traces.", async () => {
    const allowed = await authorizeScorers(projectId, access);
    if (!allowed.ok) return allowed;
    return { ok: true, count: await countLastWeek(allowed.projectId, { filter, tasks }) };
  });
}

/** What the scorer form in a Panel reads: the filter values, the tasks and the scorer to edit (null: a new one). */
export async function scorerFormAction(
  projectId: string,
  scorerId: string | null,
): Promise<
  | {
      ok: true;
      facets: TraceFilterFacets;
      tasks: TaskOption[];
      scorer: (ScorerDraft & { id: string }) | null;
    }
  | { ok: false; error: string }
> {
  return guarded("scorer_form", "Could not open the scorer. Try again.", async () => {
    const allowed = await authorizeScorers(projectId, access);
    if (!allowed.ok) return allowed;
    const id = scorerId === null ? null : parseProjectUuid(scorerId);
    const stored = id ? await getScorer(allowed.projectId, id) : null;
    if (scorerId !== null && !stored) return { ok: false, error: "The scorer does not exist." };
    const [facets, tasks] = await Promise.all([
      getTraceFilterFacets(allowed.projectId, { since: new Date(Date.now() - WEEK_MS) }),
      loadTaskOptions(allowed.projectId, stored?.tasks ?? []),
    ]);
    if (!stored) return { ok: true, facets, tasks, scorer: null };
    const { createdAt: _created, updatedAt: _updated, projectId: _project, ...scorer } = stored;
    return { ok: true, facets, tasks, scorer };
  });
}

async function guarded<T>(
  operation: string,
  error: string,
  work: () => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  if (!isDbConfigured()) return { ok: false, error: "No database is connected." };
  try {
    return await work();
  } catch (err) {
    logger.error({ err, operation }, "scorer action failed");
    reportServerException(err, "system:scorers", { operation });
    return { ok: false, error };
  }
}
