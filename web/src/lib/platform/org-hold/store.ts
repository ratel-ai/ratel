import { eq, inArray, type SQL, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";
import { orgHolds } from "./schema";
import { HOLD_CACHE_MS } from "./state";

type HoldDb = Pick<
  ReturnType<typeof getDb>,
  "select" | "insert" | "delete" | "execute" | "transaction"
>;

/** What a hold covers: a whole organization, or single projects. */
export type HoldScope =
  | { kind: "organization"; organizationId: string }
  | { kind: "projects"; projectIds: string[] };

/** How long a request from before the hold may still be writing: other processes' cache, a 60 s request, a margin. */
export const HOLD_SETTLE_MS = HOLD_CACHE_MS + 60_000 + 28_000;

/** docs/internal-api.md */
export interface HoldStatus {
  state: "none" | "held";
  since: string | null;
  projectIds: string[];
  runningJobs: number;
  queuedJobs: number;
  pendingSummarySpans: boolean;
  openTransactions: number;
  settledAt: string | null;
  quiet: boolean;
}

/** The scope's projects, or null when one of the named projects does not exist. */
export async function projectsOfScope(
  scope: HoldScope,
  db: HoldDb = getDb(),
): Promise<string[] | null> {
  if (scope.kind === "organization") {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.organizationId, scope.organizationId));
    return rows.map(({ id }) => id).sort();
  }
  const ids = [...new Set(scope.projectIds)].sort();
  if (ids.length === 0) return null;
  const rows = await db.select({ id: projects.id }).from(projects).where(inArray(projects.id, ids));
  return rows.length === ids.length ? ids : null;
}

/** A scope already on hold keeps its `since`, so a repeated call changes nothing. */
export async function setHold(scope: HoldScope, db: HoldDb = getDb()): Promise<void> {
  const rows =
    scope.kind === "organization"
      ? [{ organizationId: scope.organizationId }]
      : [...new Set(scope.projectIds)].map((projectId) => ({ projectId }));
  await db.insert(orgHolds).values(rows).onConflictDoNothing();
}

/** Lift a scope. Returns how many holds it removed. */
export async function clearHold(scope: HoldScope, db: HoldDb = getDb()): Promise<number> {
  const removed = await db
    .delete(orgHolds)
    .where(scopeCondition(scope))
    .returning({ id: orgHolds.id });
  return removed.length;
}

export async function holdStatus(
  scope: HoldScope,
  projectIds: string[],
  db: HoldDb = getDb(),
  now: () => Date = () => new Date(),
): Promise<HoldStatus> {
  const rows = await db
    .select({ since: orgHolds.since })
    .from(orgHolds)
    .where(scopeCondition(scope));
  const wanted = scope.kind === "organization" ? 1 : new Set(scope.projectIds).size;
  const held = rows.length === wanted;
  const since = held ? new Date(Math.max(...rows.map((row) => row.since.getTime()))) : null;
  const ids =
    projectIds.length > 0
      ? sql`(${sql.join(
          projectIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql`(null::uuid)`;
  const reached = since ? new Date(since.getTime() + HOLD_CACHE_MS).toISOString() : null;
  const counts = await db.execute<{
    running: number;
    queued: number;
    pending: boolean;
    transactions: number;
  }>(sql`
    select
      (select count(*)::int from jobs j where j.project_id in ${ids} and j.status = 'running') as running,
      (select count(*)::int from jobs j where j.project_id in ${ids} and j.status = 'queued') as queued,
      exists (
        select 1 from otel_spans s
        where s.project_id in ${ids}
          and (s.received_at, s.id) > coalesce(
            (select row(c.received_at, c.span_row_id) from trace_summary_cursor c limit 1),
            row('-infinity'::timestamptz, '00000000-0000-0000-0000-000000000000'::uuid)
          )
      ) as pending,
      (
        select count(*)::int from pg_stat_activity a
        where a.datname = current_database() and a.pid <> pg_backend_pid()
          and a.xact_start < ${reached}::timestamptz
      ) as transactions
  `);
  const found = counts.rows[0];
  const settledAt = since ? new Date(since.getTime() + HOLD_SETTLE_MS) : null;
  const runningJobs = Number(found?.running ?? 0);
  const openTransactions = Number(found?.transactions ?? 0);
  return {
    state: held ? "held" : "none",
    since: since?.toISOString() ?? null,
    projectIds,
    runningJobs,
    queuedJobs: Number(found?.queued ?? 0),
    pendingSummarySpans: found?.pending === true,
    openTransactions,
    settledAt: settledAt?.toISOString() ?? null,
    // Telemetry goes on being stored here, so spans that wait for their summary do not count.
    quiet:
      settledAt !== null &&
      now().getTime() >= settledAt.getTime() &&
      runningJobs === 0 &&
      openTransactions === 0,
  };
}

function scopeCondition(scope: HoldScope): SQL {
  return scope.kind === "organization"
    ? eq(orgHolds.organizationId, scope.organizationId)
    : inArray(orgHolds.projectId, scope.projectIds);
}
