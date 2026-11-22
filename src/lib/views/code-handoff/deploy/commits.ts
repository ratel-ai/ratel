import { and, asc, eq, gt, gte, inArray, isNull, like, lte, sql } from "drizzle-orm";
import { otelSpans } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import {
  type BoundReadDb,
  DEFAULT_SUPPLEMENTARY_READ_TIMEOUT_MS,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import {
  type RepoCommitRow,
  type RepoLinkRow,
  repoCommits,
  repoLinks,
} from "@/lib/views/code-handoff/schema";
import { fixShipments } from "@/lib/views/fixes/schema";
import type { CodeHandoffDb } from "../store";

/**
 * Deploy watch queries (RC-919, RC-920) that the shared store
 * (`../store.ts`) does not have. The shared store keeps the commit insert and
 * the plain reads.
 */

/** The `seq` the next pushed commit of a link takes: one past the highest. */
export async function nextCommitSeq(
  repoLinkId: string,
  db: CodeHandoffDb = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ max: sql<string | null>`max(${repoCommits.seq})` })
    .from(repoCommits)
    .where(eq(repoCommits.repoLinkId, repoLinkId));
  return Number(row?.max ?? 0) + 1;
}

/** Commits of a link whose sha starts with `prefix` (lowercase hex only, so no LIKE wildcard). */
export function findCommitsBySha(
  repoLinkId: string,
  prefix: string,
  limit: number,
  db: CodeHandoffDb = getDb(),
): Promise<RepoCommitRow[]> {
  return db
    .select()
    .from(repoCommits)
    .where(and(eq(repoCommits.repoLinkId, repoLinkId), like(repoCommits.sha, `${prefix}%`)))
    .orderBy(asc(repoCommits.seq))
    .limit(limit);
}

/** Commits up to `maxSeq` that name fixes and are not deployed, oldest first. */
export function listUndeployedTaggedCommits(
  repoLinkId: string,
  maxSeq: number,
  db: CodeHandoffDb = getDb(),
): Promise<RepoCommitRow[]> {
  return db
    .select()
    .from(repoCommits)
    .where(
      and(
        eq(repoCommits.repoLinkId, repoLinkId),
        lte(repoCommits.seq, maxSeq),
        hasFixes(),
        isNull(repoCommits.deployedAt),
      ),
    )
    .orderBy(asc(repoCommits.seq));
}

/** Mark a commit deployed if no one else has. True when this call did. */
export async function claimCommit(
  commitId: string,
  deployedAt: Date,
  db: CodeHandoffDb = getDb(),
): Promise<boolean> {
  const claimed = await db
    .update(repoCommits)
    .set({ deployedAt })
    .where(and(eq(repoCommits.id, commitId), isNull(repoCommits.deployedAt)))
    .returning({ id: repoCommits.id });
  return claimed.length > 0;
}

export async function releaseCommit(commitId: string, db: CodeHandoffDb = getDb()): Promise<void> {
  await db.update(repoCommits).set({ deployedAt: null }).where(eq(repoCommits.id, commitId));
}

export async function setCommitShipments(
  commitId: string,
  shipmentIds: string[],
  db: CodeHandoffDb = getDb(),
): Promise<void> {
  await db.update(repoCommits).set({ shipmentIds }).where(eq(repoCommits.id, commitId));
}

/**
 * The links that wait for a deploy: at least one commit names fixes and is
 * not deployed. Usually none, so the version step stops after this read.
 */
export function listLinksAwaitingDeploy(db: CodeHandoffDb = getDb()): Promise<RepoLinkRow[]> {
  const waiting = db
    .select({ id: repoCommits.repoLinkId })
    .from(repoCommits)
    .where(and(hasFixes(), isNull(repoCommits.deployedAt)));
  return db.select().from(repoLinks).where(inArray(repoLinks.id, waiting));
}

/**
 * The `service.version` values of a project's spans, since `since`, that are
 * one of `candidates` (the pending shas and their 7+ character prefixes,
 * lowercase). Asks only about pending shas, so any number of other versions
 * cannot hide a match. Served by `otel_spans_project_started_trace_idx`
 * (project_id, started_at); the version is a filter on the rows in that range.
 * Bounded by the caller's `since` and the drain's supplementary timeout.
 */
export function readMatchingServiceVersions(
  projectId: string,
  candidates: readonly string[],
  since: Date,
  db?: BoundReadDb,
): Promise<string[]> {
  if (candidates.length === 0) return Promise.resolve([]);
  return withStatementTimeout(
    async (tx) => {
      const version = sql<string>`lower(${otelSpans.attributes} ->> 'service.version')`;
      const rows = await tx
        .selectDistinct({ version })
        .from(otelSpans)
        .where(
          and(
            eq(otelSpans.projectId, projectId),
            gte(otelSpans.startedAt, since),
            sql`${version} = any(${sqlTextArray(candidates)})`,
          ),
        )
        .limit(candidates.length);
      return rows.map((row) => row.version);
    },
    {
      operation: "code_handoff_service_versions",
      db,
      timeoutMs: DEFAULT_SUPPLEMENTARY_READ_TIMEOUT_MS,
    },
  );
}

function sqlTextArray(values: readonly string[]) {
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/** The id of a project's shipment of one fix in one version (a GitHub shipment's key), if one is stored. */
export async function findShipment(
  projectId: string,
  fixId: string,
  version: string,
  db: CodeHandoffDb = getDb(),
): Promise<string | null> {
  const [row] = await db
    .select({ id: fixShipments.id })
    .from(fixShipments)
    .where(
      and(
        eq(fixShipments.projectId, projectId),
        eq(fixShipments.fixId, fixId),
        eq(fixShipments.version, version),
      ),
    )
    .orderBy(asc(fixShipments.shippedAt))
    .limit(1);
  return row?.id ?? null;
}

function hasFixes() {
  return gt(sql`cardinality(${repoCommits.fixIds})`, 0);
}
