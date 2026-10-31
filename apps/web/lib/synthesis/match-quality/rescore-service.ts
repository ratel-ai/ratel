import { and, desc, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import { loadToolCorpus } from "@/lib/ingest/runtime-catalog/inventory";
import { getDb } from "@/lib/platform/db/client";
import { matchQualityProposals, matchQualityRuns } from "@/lib/synthesis/match-quality/schema";
import { catalogFingerprints } from "@/lib/synthesis/quality/schema";
import { loadLabels, loadReplayHistory, saveRunBacktest } from "./queries";
import { REPLAY_CREDIT } from "./replay";
import { rescoreRun } from "./rescore";
import { toolEffectView } from "./tool-effect";
import type { CorpusEntry } from "./types";

/**
 * The operator pass behind `scripts/rescore-backtests.mts`.
 *
 * Finds every run whose stored backtest lacks the current `credit` marker,
 * re-scores it with `rescore.ts`, and reports the old and new numbers side by
 * side. It writes ONLY when asked to (`apply: true`); the default is a dry run,
 * so the first thing anybody sees is what would change.
 *
 * AS CLOSE TO THE ORIGINAL AS THE STORED DATA ALLOWS. Each run records the
 * fingerprint of the corpus it ran against, and `catalog_fingerprints` keeps
 * that corpus's searchable text, so the replay uses the catalog as it was then,
 * not today's. History is read only from runs up to and including this one.
 * The answer key is today's: labels are merged in place, so their past state
 * is not recoverable. When a run's fingerprint has no stored row, today's
 * catalog is used instead and the report says so.
 *
 * Deliberately not wired into the cron drain. Re-scoring overwrites stored
 * results, and that should happen when somebody chose to run it, not on deploy.
 */

type RescoreDb = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update">;

/** The two numbers a backtest headline prints, before and after its patch set. */
export interface BacktestFigures {
  /** Searches replayed. A change here means the population moved, not the curve. */
  n: number | null;
  containmentBefore: number | null;
  containmentAfter: number | null;
  qualityBefore: number | null;
  qualityAfter: number | null;
}

export interface ProposalRescore {
  proposalId: string;
  entryId: string;
  status: string;
  old: BacktestFigures | null;
  new: BacktestFigures | null;
  /** The tool's own searches with it in the list, before -> after, as the card prints it. */
  tool: { n: number; before: number; after: number } | null;
}

export interface RunRescore {
  runId: string;
  projectId: string;
  createdAt: Date;
  /** Which catalog the replay ran against: the run's own, or today's fallback. */
  corpusSource: "run" | "today";
  old: BacktestFigures | null;
  new: BacktestFigures | null;
  proposals: ProposalRescore[];
}

export interface RescoreReport {
  applied: boolean;
  runs: RunRescore[];
}

export interface RescoreOptions {
  db?: RescoreDb;
  /** Write the new results. False, the default, only reports. */
  apply?: boolean;
  /** Restrict to one project. */
  projectId?: string;
}

/** Re-score every stale run's backtests; write them only when `apply` is set. */
export async function rescoreStaleBacktests(options: RescoreOptions = {}): Promise<RescoreReport> {
  const db = options.db ?? getDb();
  const apply = options.apply ?? false;

  const filters: SQL[] = [
    isNotNull(matchQualityRuns.backtest),
    isNotNull(matchQualityRuns.tunedArm),
    isNotNull(matchQualityRuns.baselineArm),
    sql`(${matchQualityRuns.backtest} ->> 'credit') is distinct from ${REPLAY_CREDIT}`,
  ];
  if (options.projectId) filters.push(eq(matchQualityRuns.projectId, options.projectId));

  const runs = await db
    .select({
      id: matchQualityRuns.id,
      projectId: matchQualityRuns.projectId,
      createdAt: matchQualityRuns.createdAt,
      corpusFingerprint: matchQualityRuns.corpusFingerprint,
      tunedArm: matchQualityRuns.tunedArm,
      baselineArm: matchQualityRuns.baselineArm,
      backtest: matchQualityRuns.backtest,
    })
    .from(matchQualityRuns)
    .where(and(...filters))
    .orderBy(desc(matchQualityRuns.createdAt));

  const report: RunRescore[] = [];

  for (const run of runs) {
    const [runCorpus, todayCorpus, history, labels, proposals] = await Promise.all([
      loadRunCorpus(run.projectId, run.corpusFingerprint, db),
      loadToolCorpus(run.projectId, db),
      loadReplayHistory(run.projectId, undefined, db, run.createdAt),
      loadLabels(run.projectId, db),
      db
        .select({
          id: matchQualityProposals.id,
          entryId: matchQualityProposals.entryId,
          status: matchQualityProposals.status,
          currentSearchable: matchQualityProposals.currentSearchable,
          proposedSearchable: matchQualityProposals.proposedSearchable,
          backtest: matchQualityProposals.backtest,
        })
        .from(matchQualityProposals)
        .where(eq(matchQualityProposals.runId, run.id)),
    ]);

    const corpus = runCorpus ?? todayCorpus;
    const output = rescoreRun({
      corpus,
      history,
      labels,
      tunedArm: run.tunedArm!,
      baselineArm: run.baselineArm!,
      runBacktest: run.backtest,
      proposals,
    });

    if (apply) {
      for (const [proposalId, backtest] of output.proposalBacktests) {
        await db
          .update(matchQualityProposals)
          .set({ backtest: backtest as unknown as Record<string, unknown> | null })
          .where(eq(matchQualityProposals.id, proposalId));
      }
      // Null means nothing was left to replay. The old numbers would then be the
      // only ones on the page on a different scale, so they are cleared.
      await saveRunBacktest(run.id, output.runBacktest, db);
    }

    report.push({
      runId: run.id,
      projectId: run.projectId,
      createdAt: run.createdAt,
      corpusSource: runCorpus ? "run" : "today",
      old: figuresOf(run.backtest),
      new: figuresOf(output.runBacktest),
      proposals: proposals
        .filter((proposal) => output.proposalBacktests.has(proposal.id))
        .map((proposal) => ({
          proposalId: proposal.id,
          entryId: proposal.entryId,
          status: proposal.status,
          old: figuresOf(proposal.backtest),
          new: figuresOf(output.proposalBacktests.get(proposal.id) ?? null),
          tool: toolCounts(output.proposalBacktests.get(proposal.id) ?? null, proposal.entryId),
        })),
    });
  }

  return { applied: apply, runs: report };
}

/**
 * The tool corpus a run replayed against, from its stored fingerprint.
 *
 * Only the fields the replay reads are meaningful here: id, name and
 * searchable text. Null when the run recorded no fingerprint or no row for it
 * was ever stored, so the caller can fall back and say so.
 */
async function loadRunCorpus(
  projectId: string,
  fingerprint: string | null,
  db: RescoreDb,
): Promise<CorpusEntry[] | null> {
  if (!fingerprint) return null;
  const [row] = await db
    .select({ entries: catalogFingerprints.entries })
    .from(catalogFingerprints)
    .where(
      and(
        eq(catalogFingerprints.projectId, projectId),
        eq(catalogFingerprints.fingerprint, fingerprint),
      ),
    )
    .limit(1);
  const tools = (row?.entries ?? []).filter((entry) => entry.kind === "tool");
  if (tools.length === 0) return null;
  return tools.map((entry) => ({
    entryId: entry.entryId,
    name: entry.name,
    searchable: entry.searchable,
    source: "runtime",
    matchesAgentDescription: false,
    tags: [],
  }));
}

function toolCounts(raw: unknown, entryId: string): ProposalRescore["tool"] {
  const view = toolEffectView(raw, entryId);
  return view ? { n: view.n, before: view.containedBefore, after: view.containedAfter } : null;
}

/** The headline figures of a stored or fresh backtest blob, or null. */
export function figuresOf(raw: unknown): BacktestFigures | null {
  if (typeof raw !== "object" || raw === null) return null;
  const blob = raw as Record<string, unknown>;
  const pick = (side: string, key: string): number | null => {
    const score = blob[side];
    if (typeof score !== "object" || score === null) return null;
    const value = (score as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  return {
    n: typeof blob.n === "number" ? blob.n : null,
    containmentBefore: pick("before", "containment"),
    containmentAfter: pick("after", "containment"),
    qualityBefore: pick("before", "quality"),
    qualityAfter: pick("after", "quality"),
  };
}
