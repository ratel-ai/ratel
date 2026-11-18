import { sql } from "drizzle-orm";
import { composition } from "@/lib/composition/ports";
import type { CompositionPorts } from "@/lib/contracts/composition";
import type { JobKind } from "@/lib/jobs/runner";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import type { AnalysisFreshness, SectionProgress } from "@/lib/views/freshness/model";

const logger = getLogger("freshness/load");

/** How far back "last updated" looks; older than this reads as no recent analysis. */
const LOOKBACK = "30 days";

/**
 * Queued or running work older than this is stuck, not on its way: the page
 * would otherwise say "updating" for days. The reaper re-queues a job whose
 * worker died within minutes, and a backlog clears well inside this window.
 */
export const PENDING_WINDOW = "6 hours";

/**
 * A run that found too few new events and left them for a fuller one
 * (lib/intent-graph/batching.ts) changed nothing, so it never counts as an
 * update: the page would otherwise refresh for nothing every few minutes.
 */
const CHANGED_SOMETHING = sql`coalesce(result->>'outcome', '') <> 'waiting'`;

/** The edition's running import of past runs; absent in the open-source edition. */
export type RunningImportRead = CompositionPorts["runningImport"];

/**
 * A project's analysis freshness: its latest finished job, whether any are
 * queued or running (and not stuck), and an import in progress. Two small
 * reads on the project's slice of jobs_project_status_idx, and the edition's
 * running import. Owned (ADR-0030): imports are the edition's, so upstream's
 * `health_imports` read is the `runningImport` port. Without it (the
 * open-source edition) `importing` is null; a port that throws answers null
 * too, so the freshness line never breaks.
 */
export async function loadAnalysisFreshness(
  db: BoundReadDb,
  projectId: string,
  runningImport: RunningImportRead = composition.runningImport,
): Promise<AnalysisFreshness> {
  const [result, importing] = await Promise.all([
    db.execute(sql`
      select
        (select max(finished_at) from jobs
          where project_id = ${projectId} and status = 'done' and ${CHANGED_SOMETHING}
            and finished_at > now() - ${LOOKBACK}::interval) as updated_at,
        exists (select 1 from jobs
          where project_id = ${projectId} and status in ('queued', 'running')
            and created_at > now() - ${PENDING_WINDOW}::interval) as working
    `),
    readRunningImport(projectId, runningImport),
  ]);
  const [jobs] = result.rows as Array<{
    updated_at: string | Date | null;
    working: boolean;
  }>;
  const updatedAt = jobs?.updated_at ? new Date(jobs.updated_at).toISOString() : null;
  return {
    updatedAt,
    working: Boolean(jobs?.working),
    importing,
  };
}

async function readRunningImport(
  projectId: string,
  runningImport: RunningImportRead,
): Promise<{ runsImported: number } | null> {
  if (!runningImport) return null;
  try {
    const running = await runningImport(projectId);
    return running ? { runsImported: Number(running.runsImported) } : null;
  } catch (err) {
    logger.warn({ err, project_id: projectId }, "running import unreadable for freshness");
    return null;
  }
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
            where project_id = ${projectId} and kind = k.kind and status = 'done' and ${CHANGED_SOMETHING}
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
