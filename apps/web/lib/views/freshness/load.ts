import { sql } from "drizzle-orm";
import type { JobKind } from "@/lib/jobs/runner";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import type { AnalysisFreshness, SectionProgress } from "@/lib/views/freshness/model";

/** How far back "last updated" looks; older than this reads as no recent analysis. */
const LOOKBACK = "30 days";

/**
 * Queued or running work older than this is stuck, not on its way: the page
 * would otherwise say "updating" for days. The reaper re-queues a job whose
 * worker died within minutes, and a backlog clears well inside this window.
 */
export const PENDING_WINDOW = "6 hours";

/**
 * A project's analysis freshness: its latest finished job, whether any are
 * queued or running (and not stuck), and an import in progress. Three small
 * reads, each on the project's slice of an index (jobs_project_status_idx;
 * health_imports by project).
 */
export async function loadAnalysisFreshness(
  db: BoundReadDb,
  projectId: string,
): Promise<AnalysisFreshness> {
  const [jobs] = (
    await db.execute(sql`
      select
        (select max(finished_at) from jobs
          where project_id = ${projectId} and status = 'done'
            and finished_at > now() - ${LOOKBACK}::interval) as updated_at,
        exists (select 1 from jobs
          where project_id = ${projectId} and status in ('queued', 'running')
            and created_at > now() - ${PENDING_WINDOW}::interval) as working,
        (select runs_imported from health_imports
          where project_id = ${projectId} and status = 'running'
          order by started_at desc limit 1) as importing_runs
    `)
  ).rows as Array<{
    updated_at: string | Date | null;
    working: boolean;
    importing_runs: number | null;
  }>;
  const updatedAt = jobs?.updated_at ? new Date(jobs.updated_at).toISOString() : null;
  return {
    updatedAt,
    working: Boolean(jobs?.working),
    importing: jobs?.importing_runs == null ? null : { runsImported: Number(jobs.importing_runs) },
  };
}

/**
 * Where one page's analysis stands (RC-210): its newest finished job of the
 * kinds behind it, and how many of them are queued or running. The newest
 * done job is one probe per kind on jobs_project_kind_done_idx; queued and
 * running jobs (younger than PENDING_WINDOW) are a project's small slice of
 * jobs_project_status_idx.
 */
export async function loadSectionProgress(
  db: BoundReadDb,
  projectId: string,
  kinds: readonly JobKind[],
): Promise<SectionProgress> {
  if (kinds.length === 0) return { lastDoneAt: null, pending: 0 };
  const kindList = sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const [row] = (
    await db.execute(sql`
      select
        (select max(newest.finished_at) from unnest(array[${kindList}]::text[]) as k(kind)
          cross join lateral (
            select finished_at from jobs
            where project_id = ${projectId} and kind = k.kind and status = 'done'
            order by finished_at desc limit 1
          ) as newest) as last_done_at,
        (select count(*)::int from jobs
          where project_id = ${projectId} and status in ('queued', 'running')
            and kind in (${kindList}) and created_at > now() - ${PENDING_WINDOW}::interval) as pending
    `)
  ).rows as Array<{ last_done_at: string | Date | null; pending: number | null }>;
  return {
    lastDoneAt: row?.last_done_at ? new Date(row.last_done_at).toISOString() : null,
    pending: Number(row?.pending ?? 0),
  };
}
