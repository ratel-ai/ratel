import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { PLAYGROUND_ENVIRONMENT } from "@/lib/ingest/otlp/playground";
import { otelSpans } from "@/lib/ingest/otlp/schema";
import type { SandboxDb } from "./pg-store";

/**
 * The config hash a sandbox runs with in production (spec §3.7): production
 * stamps `ratel.sandbox.id` and `ratel.sandbox.config_hash` on the run's root span,
 * so the newest stamped root that is not a playground run carries it. The
 * playground compares a run's hash with it ("baseline = production config").
 */

export interface ProductionConfigQuery {
  projectId: string;
  sandboxId: string;
  now: Date;
}

/** Production stamps older than this do not count. */
export const PRODUCTION_CONFIG_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;
const SANDBOX_ID = "ratel.sandbox.id";
const CONFIG_HASH = "ratel.sandbox.config_hash";
const ENVIRONMENT = "deployment.environment.name";

/**
 * The hash of the newest production root of the sandbox in the last 30 days, or
 * null. Roots only: the stamps land on the root, and
 * `otel_spans_project_roots_started_idx` (project_id, started_at, roots) bounds
 * the scan by project and time, newest first.
 */
export async function readProductionConfigHash(
  db: SandboxDb,
  { projectId, sandboxId, now }: ProductionConfigQuery,
): Promise<string | null> {
  const since = new Date(now.getTime() - PRODUCTION_CONFIG_WINDOW_DAYS * DAY_MS);
  const hash = sql<string>`${otelSpans.attributes}->>${CONFIG_HASH}`;
  const [row] = await db
    .select({ hash })
    .from(otelSpans)
    .where(
      and(
        eq(otelSpans.projectId, projectId),
        isNull(otelSpans.parentSpanId),
        gte(otelSpans.startedAt, since),
        sql`${otelSpans.attributes}->>${SANDBOX_ID} = ${sandboxId}`,
        isNotNull(hash),
        sql`${otelSpans.attributes}->>${ENVIRONMENT} is distinct from ${PLAYGROUND_ENVIRONMENT}`,
      ),
    )
    .orderBy(desc(otelSpans.startedAt))
    .limit(1);
  return row?.hash ?? null;
}
