import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { skills } from "@/lib/catalog/schema";
import { otelSpans } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";

/**
 * The home recap's counts (owned fragment of the upstream queries hub, ADR-0030): what the
 * project overview and the MCP `get_project_overview` tool show first.
 */

export type ProjectHomeEntityCounts = {
  skills: number;
  activeExperiments: number;
};

export type ProjectHomeQueriesDb = Pick<ReturnType<typeof getDb>, "select">;

/** Project-map totals for the Home recap. Skills mirror the full catalog surface;
 * experiment activity is bounded so Home never turns an all-time span scan hot. */
export async function getProjectHomeEntityCounts(
  projectId: string,
  experimentSince: Date,
  experimentUntil: Date,
  db: ProjectHomeQueriesDb = getDb(),
): Promise<ProjectHomeEntityCounts> {
  const [skillRows, experimentRows] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(skills)
      .where(eq(skills.projectId, projectId)),
    db
      .select({
        n: sql<number>`count(distinct ${otelSpans.experimentName})::int`,
      })
      .from(otelSpans)
      .where(
        and(
          eq(otelSpans.projectId, projectId),
          gte(otelSpans.startedAt, experimentSince),
          lt(otelSpans.startedAt, experimentUntil),
          isNotNull(otelSpans.experimentName),
          isNotNull(otelSpans.experimentArm),
          sql`btrim(${otelSpans.experimentName}) <> ''`,
          sql`btrim(${otelSpans.experimentArm}) <> ''`,
        ),
      ),
  ]);

  return {
    skills: skillRows[0]?.n ?? 0,
    activeExperiments: experimentRows[0]?.n ?? 0,
  };
}
