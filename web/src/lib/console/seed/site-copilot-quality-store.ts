import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  SITE_QUALITY_EXPERIMENT,
  SITE_QUALITY_THEIRS,
} from "@/lib/console/seed/site-copilot-quality";
import { otelLogs, otelSpans } from "@/lib/ingest/otlp/schema";
import type { getDb } from "@/lib/platform/db/client";
import { apiKeys } from "@/lib/platform/projects/schema";
import { swapRuntimeOverride } from "@/lib/synthesis/match-quality/queries";
import {
  matchQualityLabels,
  matchQualityProposals,
  matchQualityRuns,
} from "@/lib/synthesis/match-quality/schema";

/**
 * The database side of the Site Copilot quality seed
 * (`scripts/seed-site-copilot-quality.mts`): taking out what it wrote, reading
 * when each stored turn happened, and tagging the turns its experiment ran in.
 * The searches themselves go in through the OTLP logs handler, and the runs
 * through Match quality's own pipeline.
 */

type Db = ReturnType<typeof getDb>;

/** Queries over trace ids stay well under Postgres's bind-parameter ceiling. */
const CHUNK = 500;

/** The key the Site Copilot seed creates with the project (`seed-site-copilot.mts`). */
export const SITE_COPILOT_KEY_NAME = "site-copilot-seed";

export interface SiteQualityReset {
  overrides: number;
  runs: number;
  labels: number;
  logs: number;
  spans: number;
}

/**
 * Everything the quality seed wrote, taken out: applied rewrites first (each
 * entry gets back the text it had before, newest apply first so an entry
 * rewritten twice ends on its original), then the runs with their frozen
 * searches and rewrites, the answer key, the experiment's records and its tags
 * on the turns. Match quality data on this project is the seed's to replace.
 */
export async function resetSiteQuality(projectId: string, db: Db): Promise<SiteQualityReset> {
  const applied = await db
    .select({
      entryId: matchQualityProposals.entryId,
      previousOverride: matchQualityProposals.previousOverride,
    })
    .from(matchQualityProposals)
    .where(
      and(
        eq(matchQualityProposals.projectId, projectId),
        eq(matchQualityProposals.status, "applied"),
      ),
    )
    .orderBy(desc(matchQualityProposals.appliedAt));
  let overrides = 0;
  for (const row of applied) {
    if (await swapRuntimeOverride(projectId, row.entryId, row.previousOverride, db)) overrides += 1;
  }
  const runs = await db
    .delete(matchQualityRuns)
    .where(eq(matchQualityRuns.projectId, projectId))
    .returning({ id: matchQualityRuns.id });
  const labels = await db
    .delete(matchQualityLabels)
    .where(eq(matchQualityLabels.projectId, projectId))
    .returning({ id: matchQualityLabels.id });
  const logs = await db
    .delete(otelLogs)
    .where(
      and(eq(otelLogs.projectId, projectId), eq(otelLogs.experimentName, SITE_QUALITY_EXPERIMENT)),
    )
    .returning({ id: otelLogs.id });
  const spans = await db
    .update(otelSpans)
    .set({ experimentName: null, experimentArm: null, experimentRole: null })
    .where(
      and(
        eq(otelSpans.projectId, projectId),
        eq(otelSpans.experimentName, SITE_QUALITY_EXPERIMENT),
      ),
    )
    .returning({ id: otelSpans.id });
  return {
    overrides,
    runs: runs.length,
    labels: labels.length,
    logs: logs.length,
    spans: spans.length,
  };
}

/** When each turn started: its root span's start, by trace id. Traces not stored are absent. */
export async function rootSpanStarts(
  projectId: string,
  traceIds: readonly string[],
  db: Db,
): Promise<Map<string, Date>> {
  const starts = new Map<string, Date>();
  const unique = [...new Set(traceIds)];
  for (let offset = 0; offset < unique.length; offset += CHUNK) {
    const rows = await db
      .select({ traceId: otelSpans.traceId, startedAt: otelSpans.startedAt })
      .from(otelSpans)
      .where(
        and(
          eq(otelSpans.projectId, projectId),
          isNull(otelSpans.parentSpanId),
          inArray(otelSpans.traceId, unique.slice(offset, offset + CHUNK)),
        ),
      );
    for (const row of rows)
      starts.set(
        row.traceId,
        row.startedAt instanceof Date ? row.startedAt : new Date(row.startedAt),
      );
  }
  return starts;
}

/**
 * Mark each searched turn as served by the customer's variant, the way the SDK
 * stamps `ratel.experiment.*` on the spans of a request it ran an experiment
 * on. Experiments are found from these tags; their numbers come from the logs.
 */
export async function tagExperimentTraces(
  projectId: string,
  traceIds: readonly string[],
  db: Db,
): Promise<number> {
  let tagged = 0;
  const unique = [...new Set(traceIds)];
  for (let offset = 0; offset < unique.length; offset += CHUNK) {
    const rows = await db
      .update(otelSpans)
      .set({
        experimentName: SITE_QUALITY_EXPERIMENT,
        experimentArm: SITE_QUALITY_THEIRS,
        experimentRole: "serving",
      })
      .where(
        and(
          eq(otelSpans.projectId, projectId),
          isNull(otelSpans.parentSpanId),
          inArray(otelSpans.traceId, unique.slice(offset, offset + CHUNK)),
        ),
      )
      .returning({ id: otelSpans.id });
    tagged += rows.length;
  }
  return tagged;
}
