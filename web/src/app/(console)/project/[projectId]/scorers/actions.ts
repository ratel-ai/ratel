"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import {
  authorizeScorers,
  changeScorer,
  type ScorerAccessDeps,
  type ScorerActionResult,
} from "@/lib/views/scorers/actions";
import { parseFilter, parseScorerDraft } from "@/lib/views/scorers/config";
import { countLastWeek, type PreviewResult, previewScorer } from "@/lib/views/scorers/preview";
import {
  createScorer,
  deleteScorer,
  getScorer,
  setScorerEnabled,
  updateScorer,
} from "@/lib/views/scorers/store";

const logger = getLogger("scorers/actions");

const access: ScorerAccessDeps = {
  getSession: getSessionContext,
  findProjectScope: (projectId) => findProjectScope(projectId),
  enabled: (subject) => featureEnabled("scorers", subject),
};

/** Create, update, switch or delete a scorer. */
export async function changeScorerAction(input: unknown): Promise<ScorerActionResult> {
  return guarded("scorer_change", "Could not save the scorer. Try again.", () =>
    changeScorer(input, {
      ...access,
      get: (projectId, scorerId) => getScorer(projectId, scorerId),
      create: (projectId, draft, actor) => createScorer(projectId, draft, actor),
      update: (projectId, scorerId, draft, actor) =>
        updateScorer(projectId, scorerId, draft, actor),
      setEnabled: (projectId, scorerId, enabled, actor) =>
        setScorerEnabled(projectId, scorerId, enabled, actor),
      remove: (projectId, scorerId) => deleteScorer(projectId, scorerId),
      observe: async (fields) => {
        await trackServerEvent(
          "feature.scorers.changed",
          { externalId: fields.actor, projectId: fields.project_id, orgId: fields.organization_id },
          fields,
        );
        revalidatePath(`/project/${fields.project_id}/scorers`, "layout");
      },
    }),
  );
}

/** Run a draft on the newest matching traces; no result is stored. */
export async function testScorerAction(
  projectId: string,
  draft: unknown,
): Promise<{ ok: true; results: PreviewResult[] } | { ok: false; error: string }> {
  const parsed = parseScorerDraft(draft);
  if (!parsed.ok) return parsed;
  return guarded("scorer_test", "Could not test the scorer. Try again.", async () => {
    const allowed = await authorizeScorers(projectId, access);
    if (!allowed.ok) return allowed;
    return { ok: true, results: await previewScorer(allowed.projectId, parsed.draft) };
  });
}

/** How many traces of the last 7 days a filter matches. */
export async function countScorerTracesAction(
  projectId: string,
  rawFilter: unknown,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const filter = parseFilter(rawFilter);
  if (!filter) return { ok: false, error: "The trace filter is invalid." };
  return guarded("scorer_count", "Could not count the traces.", async () => {
    const allowed = await authorizeScorers(projectId, access);
    if (!allowed.ok) return allowed;
    return { ok: true, count: await countLastWeek(allowed.projectId, filter) };
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
