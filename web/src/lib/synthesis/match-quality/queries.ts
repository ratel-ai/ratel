import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { getDb } from "@/lib/platform/db/client";
import {
  type MatchQualityProposalRow,
  type MatchQualityRunRow,
  matchQualityEvalItems,
  matchQualityLabels,
  matchQualityProposals,
  matchQualityRuns,
} from "@/lib/synthesis/match-quality/schema";
import { catalogFingerprints } from "@/lib/synthesis/quality/schema";
import type { GroundTruthLabel } from "./labels";
import type { ReplayResult } from "./replay";
import type {
  AnalystProposal,
  CorpusEntry,
  EvalItem,
  ProposalPreview,
  RunCensus,
  TargetSource,
} from "./types";

/**
 * The database layer for match quality.
 *
 * Every function takes an injectable `db` so the pipeline above it tests against
 * PGlite without a live Postgres, matching the convention the rest of `lib/`
 * follows.
 */

export type MatchQualityDb = ReturnType<typeof getDb>;
type ReadDb = Pick<MatchQualityDb, "select">;
type WriteDb = Pick<MatchQualityDb, "select" | "insert" | "update">;
/** A handle that can also open a transaction, or one already inside one. */
type TxDb = WriteDb & Partial<Pick<MatchQualityDb, "transaction">>;

export interface StartRunInput {
  projectId: string;
  experimentName: string;
  trigger: "scheduled" | "manual";
  windowDays: number;
  windowStart: Date;
  windowEnd: Date;
}

/**
 * Claim the project's single live run slot.
 *
 * Returns null when one is already queued or running. The partial unique index
 * is the authority here, not this read: two concurrent callers would both see an
 * empty slot, and only one insert can win. Catching the violation and answering
 * null is what makes "the weekly sweep and a manual click raced" a no-op for the
 * loser rather than a 500.
 */
export async function startRun(
  input: StartRunInput,
  db: WriteDb = getDb(),
  now: Date = new Date(),
): Promise<MatchQualityRunRow | null> {
  const [row] = await db
    .insert(matchQualityRuns)
    .values({
      projectId: input.projectId,
      experimentName: input.experimentName,
      trigger: input.trigger,
      status: "queued",
      windowDays: input.windowDays,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function markRunRunning(
  runId: string,
  db: WriteDb = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(matchQualityRuns)
    .set({ status: "running", startedAt: now })
    .where(eq(matchQualityRuns.id, runId));
}

export interface FinishRunInput {
  census: RunCensus;
  scores: Record<string, unknown>;
  observedStages: Record<string, unknown>;
  followThrough: Record<string, unknown>;
  corpusFingerprint: string | null;
  model: string | null;
  mocked: boolean;
  diagnosis: string | null;
  diagnosisPoints: Array<{ title: string; detail: string }>;
  declinedReason: string | null;
  scorer: string;
  /** The judging census, or `{}` when no judge ran. */
  judge: Record<string, unknown>;
  /** The portfolio replay. Optional so existing call sites keep working. */
  backtest?: ReplayResult | null;
  /**
   * What this run learned, folded into the project's answer key.
   *
   * Carried on the finish payload rather than as another positional argument so
   * that every existing caller of {@link persistFinishedRun} keeps compiling and
   * keeps behaving: absent means no key write, which is what they all did before.
   * `finishRun` itself ignores it; only the transaction reads it.
   */
  labels?: readonly GroundTruthLabel[];
}

export async function finishRun(
  runId: string,
  input: FinishRunInput,
  db: WriteDb = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(matchQualityRuns)
    .set({
      status: "analyzed",
      selectionsEvaluated: input.census.selectionsEvaluated,
      revealedN: input.census.revealedN,
      referenceN: input.census.referenceN,
      judgedN: input.census.judgedN,
      queriesCaptured: input.census.queriesCaptured,
      truncated: input.census.truncated,
      attributionMode: input.census.attributionMode,
      invokedToolKey: input.census.invokedToolKey,
      revealedSource: input.census.revealedSource,
      baselineArm: input.census.baselineArm,
      servingArm: input.census.servingArm,
      tunedArm: input.census.tunedArm,
      followThrough: input.followThrough,
      observedStages: input.observedStages,
      scores: input.scores,
      corpusFingerprint: input.corpusFingerprint,
      model: input.model,
      mocked: input.mocked,
      diagnosis: input.diagnosis,
      diagnosisPoints: input.diagnosisPoints,
      declinedReason: input.declinedReason,
      scorer: input.scorer,
      judge: input.judge,
      backtest: (input.backtest ?? null) as unknown as Record<string, unknown> | null,
      finishedAt: now,
    })
    .where(eq(matchQualityRuns.id, runId));
}

export async function failRun(
  runId: string,
  message: string,
  db: WriteDb = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(matchQualityRuns)
    .set({ status: "failed", error: message.slice(0, 2_000), finishedAt: now })
    .where(eq(matchQualityRuns.id, runId));
}

/** Freeze a run's evaluation set. Chunked for Postgres's bind-parameter ceiling. */
export async function insertEvalItems(
  runId: string,
  projectId: string,
  items: readonly EvalItem[],
  db: WriteDb = getDb(),
): Promise<void> {
  const CHUNK = 250;
  for (let offset = 0; offset < items.length; offset += CHUNK) {
    const slice = items.slice(offset, offset + CHUNK);
    if (slice.length === 0) continue;
    await db.insert(matchQualityEvalItems).values(
      slice.map((item) => ({
        runId,
        projectId,
        selectionId: item.selectionId,
        occurredAt: item.occurredAt,
        query: item.query,
        targetEntryId: item.targetEntryId,
        targetKind: item.targetKind,
        targetSource: item.targetSource,
        arms: item.arms,
      })),
    );
  }
}

export interface ProposalInsert {
  proposal: AnalystProposal;
  entry: CorpusEntry;
  preview: ProposalPreview;
  evidence: Record<string, unknown>;
  /** This rewrite replayed alone over the answer key. Null when none ran. */
  backtest?: ReplayResult | null;
  /**
   * Where this proposal starts life. `pending` for everything the pipeline
   * offers; the discard path deletes rather than storing, so nothing writes
   * `dismissed` here today. Kept because a caller may still want to seed a row
   * in a terminal state, and defaulting to `pending` leaves every existing call
   * site behaving exactly as it did.
   */
  status?: "pending" | "dismissed";
}

/**
 * Replace the project's open proposals with this run's.
 *
 * Superseding FIRST, in the same transaction, is what makes "suggestions never
 * stack" true rather than aspirational: the partial unique index on one pending
 * proposal per entry would otherwise reject the new row and silently leave last
 * week's stale text on the page as though it were this week's answer.
 */
export async function replacePendingProposals(
  runId: string,
  projectId: string,
  inserts: readonly ProposalInsert[],
  db: TxDb = getDb(),
  now: Date = new Date(),
): Promise<number> {
  return replacePendingProposalsIn(db, runId, projectId, inserts, now);
}

/** The body of {@link replacePendingProposals}, for a caller already in a tx. */
async function replacePendingProposalsIn(
  tx: TxDb,
  runId: string,
  projectId: string,
  inserts: readonly ProposalInsert[],
  now: Date,
): Promise<number> {
  {
    await tx
      .update(matchQualityProposals)
      .set({ status: "superseded", updatedAt: now })
      .where(
        and(
          eq(matchQualityProposals.projectId, projectId),
          eq(matchQualityProposals.status, "pending"),
        ),
      );
    if (inserts.length === 0) return 0;
    const rows = await tx
      .insert(matchQualityProposals)
      .values(
        inserts.map((insert) => ({
          runId,
          projectId,
          entryId: insert.proposal.entryId,
          entryName: insert.entry.name,
          status: insert.status ?? "pending",
          currentSearchable: insert.entry.searchable,
          currentSource: insert.entry.source,
          proposedSearchable: insert.proposal.searchableDescription,
          rationale: insert.proposal.rationale,
          evidence: insert.evidence,
          preview: insert.preview as unknown as Record<string, unknown>,
          backtest: (insert.backtest ?? null) as unknown as Record<string, unknown> | null,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning({ id: matchQualityProposals.id });
    return rows.length;
  }
}

/**
 * Everything one finished run writes, in a single transaction.
 *
 * Three separate writes would let `finishRun` fail after the proposals had
 * already committed, leaving a run marked `failed` with that same run's
 * proposals live on the page underneath a banner saying nothing happened. A run
 * either landed or it did not.
 */
export async function persistFinishedRun(
  runId: string,
  projectId: string,
  items: readonly EvalItem[],
  inserts: readonly ProposalInsert[],
  finish: FinishRunInput,
  db: MatchQualityDb = getDb(),
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await insertEvalItems(runId, projectId, items, tx);
    // Inside the same transaction as everything else the run learned. A key that
    // committed while the run then failed would have the next run skip judging
    // requests whose verdicts were never published anywhere a reader can see.
    await upsertLabels(projectId, finish.labels ?? [], tx, now);
    await replacePendingProposalsIn(tx, runId, projectId, inserts, now);
    await finishRun(runId, finish, tx, now);
  });
}

export async function getRun(
  runId: string,
  db: ReadDb = getDb(),
): Promise<MatchQualityRunRow | null> {
  const [row] = await db
    .select()
    .from(matchQualityRuns)
    .where(eq(matchQualityRuns.id, runId))
    .limit(1);
  return row ?? null;
}

/** The run a project's surface shows: its most recent, live or finished. */
export async function getLatestRun(
  projectId: string,
  db: ReadDb = getDb(),
): Promise<MatchQualityRunRow | null> {
  const [row] = await db
    .select()
    .from(matchQualityRuns)
    .where(eq(matchQualityRuns.projectId, projectId))
    .orderBy(desc(matchQualityRuns.createdAt))
    .limit(1);
  return row ?? null;
}

export async function listRuns(
  projectId: string,
  limit = 20,
  db: ReadDb = getDb(),
): Promise<MatchQualityRunRow[]> {
  return db
    .select()
    .from(matchQualityRuns)
    .where(eq(matchQualityRuns.projectId, projectId))
    .orderBy(desc(matchQualityRuns.createdAt))
    .limit(limit);
}

export async function listProposals(
  projectId: string,
  opts: { runId?: string; statuses?: readonly string[] } = {},
  db: ReadDb = getDb(),
): Promise<MatchQualityProposalRow[]> {
  const filters = [eq(matchQualityProposals.projectId, projectId)];
  if (opts.runId) filters.push(eq(matchQualityProposals.runId, opts.runId));
  if (opts.statuses && opts.statuses.length > 0) {
    filters.push(inArray(matchQualityProposals.status, [...opts.statuses]));
  }
  return db
    .select()
    .from(matchQualityProposals)
    .where(and(...filters))
    .orderBy(asc(matchQualityProposals.entryName));
}

export async function getProposal(
  projectId: string,
  proposalId: string,
  db: ReadDb = getDb(),
): Promise<MatchQualityProposalRow | null> {
  const [row] = await db
    .select()
    .from(matchQualityProposals)
    .where(
      and(eq(matchQualityProposals.projectId, projectId), eq(matchQualityProposals.id, proposalId)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Move a proposal to a terminal state, but only from the state it is allowed to
 * leave.
 *
 * The `from` predicate is the concurrency guard: two operators clicking Apply on
 * the same proposal both read `pending`, and without it the second would overwrite
 * the first's `previous_override` with the text the first had just written,
 * making Revert restore the proposal instead of the original.
 */
export async function transitionProposal(
  proposalId: string,
  from: string,
  to: string,
  // Nullable, not just optional: releasing a claim has to CLEAR `applied_at` and
  // `applied_by`, and drizzle's `set` skips undefined keys rather than nulling
  // them, so `undefined` would silently leave the stale values behind.
  extra: Partial<{
    appliedAt: Date | null;
    appliedBy: string | null;
    revertedAt: Date | null;
    previousOverride: string | null;
  }> = {},
  db: WriteDb = getDb(),
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(matchQualityProposals)
    .set({ status: to, updatedAt: now, ...extra })
    .where(and(eq(matchQualityProposals.id, proposalId), eq(matchQualityProposals.status, from)))
    .returning({ id: matchQualityProposals.id });
  return rows.length > 0;
}

/**
 * Swap one entry's override and return what it displaced, in one statement.
 *
 * A read-then-write would be a lost update: `searchable_description_override` has
 * three writers (the Catalogs editor, the MCP `set_catalog_override` operation,
 * and this), so a hand edit landing between the read and the write would be
 * silently overwritten AND mis-recorded, leaving Revert to restore a value that
 * was never actually displaced. That is precisely the guarantee `previous_override`
 * exists to make, so it cannot rest on two statements and a narrow window.
 *
 * The CTE reads the prior value inside the same statement that replaces it, so
 * the pair is atomic under Postgres's row lock. Returns `undefined` when there is
 * no such entry, which the caller must distinguish from a stored `null`.
 */
export async function swapRuntimeOverride(
  projectId: string,
  entryId: string,
  next: string | null,
  db: Pick<MatchQualityDb, "execute"> = getDb(),
): Promise<{ previous: string | null } | undefined> {
  // A self-join against the pre-update snapshot, not a CTE: a scalar subquery in
  // RETURNING that reads the same table sees the NEW row and answers null, which
  // is a silent wrong answer rather than an error. The `for update` is what makes
  // the pair atomic, serializing two concurrent swaps of the same entry.
  //
  // Three outcomes, all distinct and all load-bearing: a row with a value, a row
  // with null (the entry exists and had no override), and no row at all (the
  // entry is gone).
  const result = await db.execute<{ previous: string | null }>(sql`
    update ${runtimeCatalogEntries}
    set searchable_description_override = ${next}
    from (
      select ${runtimeCatalogEntries.entryId} as entry_id,
             ${runtimeCatalogEntries.searchableDescriptionOverride} as previous
      from ${runtimeCatalogEntries}
      where ${runtimeCatalogEntries.projectId} = ${projectId}
        and ${runtimeCatalogEntries.kind} = 'tool'
        and ${runtimeCatalogEntries.entryId} = ${entryId}
      for update
    ) as prior
    where ${runtimeCatalogEntries.projectId} = ${projectId}
      and ${runtimeCatalogEntries.kind} = 'tool'
      and ${runtimeCatalogEntries.entryId} = prior.entry_id
    returning prior.previous as previous
  `);
  const rows = Array.isArray(result) ? result : result.rows;
  const row = rows[0];
  return row === undefined ? undefined : { previous: row.previous ?? null };
}

/** Runs created in the current billing period, for the plan budget check. */
export async function countRunsSince(
  projectId: string,
  since: Date,
  db: ReadDb = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(matchQualityRuns)
    .where(and(eq(matchQualityRuns.projectId, projectId), gte(matchQualityRuns.createdAt, since)));
  return row?.total ?? 0;
}

/**
 * When the corpus this project matches on last actually changed.
 *
 * Read from `catalog_fingerprints`, not from when a proposal was applied: an
 * operator editing a description by hand in Catalogs moves retrieval just as much
 * as this feature does, and a window that ignored that would re-analyse data
 * generated by a corpus that no longer exists.
 */
export async function lastCorpusChangeAt(
  projectId: string,
  db: ReadDb = getDb(),
): Promise<Date | null> {
  const [row] = await db
    .select({ firstSeenAt: catalogFingerprints.firstSeenAt })
    .from(catalogFingerprints)
    .where(eq(catalogFingerprints.projectId, projectId))
    .orderBy(desc(catalogFingerprints.firstSeenAt))
    .limit(1);
  return row?.firstSeenAt ?? null;
}

/** Projects with a finished run, oldest first: the sweep's rotation order. */
export async function lastRunByProject(db: ReadDb = getDb()): Promise<Map<string, Date>> {
  const rows = await db
    .select({
      projectId: matchQualityRuns.projectId,
      lastAt: sql<Date>`max(${matchQualityRuns.createdAt})`,
    })
    .from(matchQualityRuns)
    .groupBy(matchQualityRuns.projectId);
  return new Map(rows.map((row) => [row.projectId, new Date(row.lastAt)]));
}

/* — the accumulating answer key --------------------------------------------- */

/**
 * Whether an incoming sighting should replace the stored one.
 *
 * The precedence rule from `labels.ts:mergeLabel`, expressed as a SQL predicate
 * so that both halves of the system enforce one rule rather than two that agree
 * until they do not. Strength first (an observed invocation beats any verdict
 * about one), recency second, and never the other way round.
 *
 * `source` is compared through an explicit rank rather than as text: 'invoked'
 * happens to sort after 'judge' alphabetically, and resting on that would make
 * the whole thing break silently the day a third source is added.
 */
const SOURCE_RANK = sql`case excluded.source when 'invoked' then 2 else 1 end`;
const STORED_RANK = sql`case ${matchQualityLabels.source} when 'invoked' then 2 else 1 end`;
const WINS = sql`(
  ${SOURCE_RANK} > ${STORED_RANK}
  or (${SOURCE_RANK} = ${STORED_RANK} and excluded.observed_at > ${matchQualityLabels.observedAt})
)`;

/**
 * Write what this run learned into the project's answer key.
 *
 * One statement, conflict-resolved in SQL rather than read-then-written, because
 * the weekly sweep and a manual run can be judging overlapping windows at the
 * same moment and a read-then-write would let the loser's verdict silently
 * replace the winner's. {@link WINS} is `labels.ts:mergeLabel`'s precedence rule
 * as a predicate, so both paths enforce one rule and the database decides.
 *
 * The answer columns move together under that predicate, so a row can never end
 * up with one sighting's entry id and another's model. The occurrence count sits
 * outside it, because it measures how often the request is asked rather than who
 * answered it.
 */
export async function upsertLabels(
  projectId: string,
  labels: readonly GroundTruthLabel[],
  db: WriteDb = getDb(),
  now: Date = new Date(),
): Promise<number> {
  if (labels.length === 0) return 0;
  const CHUNK = 250;
  let written = 0;

  for (let offset = 0; offset < labels.length; offset += CHUNK) {
    const slice = labels.slice(offset, offset + CHUNK);
    if (slice.length === 0) continue;
    const rows = await db
      .insert(matchQualityLabels)
      .values(
        slice.map((label) => ({
          projectId,
          queryKey: label.queryKey,
          query: label.query,
          entryId: label.entryId,
          source: label.source,
          confident: label.confident,
          model: label.model,
          selectionId: label.selectionId,
          occurrences: label.occurrences,
          observedAt: label.observedAt,
          confidence: label.confidence ?? null,
          runnerUp: label.runnerUp ?? null,
          catalogFingerprint: label.catalogFingerprint ?? null,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [matchQualityLabels.projectId, matchQualityLabels.queryKey],
        set: {
          query: sql`case when ${WINS} then excluded.query else ${matchQualityLabels.query} end`,
          entryId: sql`case when ${WINS} then excluded.entry_id else ${matchQualityLabels.entryId} end`,
          source: sql`case when ${WINS} then excluded.source else ${matchQualityLabels.source} end`,
          confident: sql`case when ${WINS} then excluded.confident else ${matchQualityLabels.confident} end`,
          model: sql`case when ${WINS} then excluded.model else ${matchQualityLabels.model} end`,
          selectionId: sql`case when ${WINS} then excluded.selection_id else ${matchQualityLabels.selectionId} end`,
          observedAt: sql`case when ${WINS} then excluded.observed_at else ${matchQualityLabels.observedAt} end`,
          confidence: sql`case when ${WINS} then excluded.confidence else ${matchQualityLabels.confidence} end`,
          runnerUp: sql`case when ${WINS} then excluded.runner_up else ${matchQualityLabels.runnerUp} end`,
          catalogFingerprint: sql`case when ${WINS} then excluded.catalog_fingerprint else ${matchQualityLabels.catalogFingerprint} end`,
          // Outside the CASE deliberately: this counts how often the request is
          // ASKED, which is true no matter which answer survived. A `where` clause
          // on the update would have been terser and would have dropped this count
          // on every losing upsert, quietly disagreeing with `mergeLabel`.
          occurrences: sql`${matchQualityLabels.occurrences} + excluded.occurrences`,
          updatedAt: now,
        },
      })
      .returning({ id: matchQualityLabels.id });
    written += rows.length;
  }
  return written;
}

/**
 * The project's whole answer key, keyed for {@link buildReplayCases}.
 *
 * Unbounded on purpose: this is at most one row per distinct request a project
 * has ever had judged or observed, which is thousands at the very most, and
 * paging it would mean a replay silently scoring against part of the key while
 * reporting the whole.
 */
export async function loadLabels(
  projectId: string,
  db: ReadDb = getDb(),
): Promise<Map<string, GroundTruthLabel>> {
  const rows = await db
    .select()
    .from(matchQualityLabels)
    .where(eq(matchQualityLabels.projectId, projectId));

  return new Map(
    rows.map((row) => [
      row.queryKey,
      {
        queryKey: row.queryKey,
        query: row.query,
        entryId: row.entryId,
        source:
          row.source === "invoked"
            ? ("invoked" as const)
            : row.source === "unclear"
              ? ("unclear" as const)
              : ("judge" as const),
        confident: row.confident,
        model: row.model,
        selectionId: row.selectionId,
        occurrences: row.occurrences,
        observedAt: row.observedAt,
        confidence: row.confidence,
        runnerUp: row.runnerUp,
        catalogFingerprint: row.catalogFingerprint,
      },
    ]),
  );
}

/** How many requests this project has a real answer for, by source. */
export async function countLabels(
  projectId: string,
  db: ReadDb = getDb(),
): Promise<{ invoked: number; judged: number; unclear: number }> {
  const rows = await db
    .select({ source: matchQualityLabels.source, total: sql<number>`count(*)::int` })
    .from(matchQualityLabels)
    .where(eq(matchQualityLabels.projectId, projectId))
    .groupBy(matchQualityLabels.source);

  let invoked = 0;
  let judged = 0;
  let unclear = 0;
  for (const row of rows) {
    if (row.source === "invoked") invoked = row.total;
    else if (row.source === "unclear") unclear = row.total;
    else judged += row.total;
  }
  return { invoked, judged, unclear };
}

/* — the frozen history a backtest replays ------------------------------------ */

/**
 * How far back a replay reaches.
 *
 * Every run this project has ever finished froze its evaluation set, so the
 * history grows without bound while the corpus it would be replayed against is
 * today's. This caps the READ; `replay.ts` then thins what it gets by stride, so
 * the population still spans the whole history rather than its newest corner.
 * Ordered newest first so the cap, when it binds, drops the oldest evidence
 * rather than an arbitrary slice.
 */
export const MAX_REPLAY_HISTORY_ROWS = 20_000;

/**
 * Every search this project has ever frozen, newest first.
 *
 * Read across ALL runs, not just the latest: that is the difference between "how
 * did this week look" and the question a backtest exists to answer, which is
 * whether the catalog is getting better over the whole record. The rows outlive
 * `otel_logs`'s thirty-day pruning, so this reaches back further than any live
 * telemetry query could.
 *
 * `until` limits the read to runs created at or before that moment, which is
 * the history a past run's own backtest saw. Omitted, it reads everything.
 */
export async function loadReplayHistory(
  projectId: string,
  limit: number = MAX_REPLAY_HISTORY_ROWS,
  db: ReadDb = getDb(),
  until?: Date,
): Promise<EvalItem[]> {
  const scope = [eq(matchQualityEvalItems.projectId, projectId)];
  if (until) {
    scope.push(
      inArray(
        matchQualityEvalItems.runId,
        db
          .select({ id: matchQualityRuns.id })
          .from(matchQualityRuns)
          .where(
            and(eq(matchQualityRuns.projectId, projectId), lte(matchQualityRuns.createdAt, until)),
          ),
      ),
    );
  }
  const rows = await db
    .select({
      selectionId: matchQualityEvalItems.selectionId,
      occurredAt: matchQualityEvalItems.occurredAt,
      query: matchQualityEvalItems.query,
      targetEntryId: matchQualityEvalItems.targetEntryId,
      targetKind: matchQualityEvalItems.targetKind,
      targetSource: matchQualityEvalItems.targetSource,
      arms: matchQualityEvalItems.arms,
    })
    .from(matchQualityEvalItems)
    .where(and(...scope))
    .orderBy(desc(matchQualityEvalItems.occurredAt))
    .limit(limit);

  return rows.map((row) => ({
    selectionId: row.selectionId,
    occurredAt: row.occurredAt,
    query: row.query,
    targetEntryId: row.targetEntryId,
    targetKind: row.targetKind,
    targetSource: row.targetSource as TargetSource,
    arms: (row.arms ?? []).map((arm) => ({
      arm: arm.arm,
      role: arm.role,
      resultIds: [...arm.resultIds],
      resultScores: arm.resultScores ? [...arm.resultScores] : null,
    })),
  }));
}

/** Attach a finished portfolio backtest to its run. */
export async function saveRunBacktest(
  runId: string,
  backtest: ReplayResult | null,
  db: WriteDb = getDb(),
): Promise<void> {
  await db
    .update(matchQualityRuns)
    .set({ backtest: backtest as unknown as Record<string, unknown> | null })
    .where(eq(matchQualityRuns.id, runId));
}
