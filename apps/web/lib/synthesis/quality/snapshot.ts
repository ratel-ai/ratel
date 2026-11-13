import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import type { ExperimentWindow } from "@/lib/synthesis/experiments/service";
import { recordCatalogFingerprint } from "@/lib/synthesis/quality/fingerprint";
import {
  byArm,
  EVIDENCE_TIERS,
  type EvaluableSelection,
  observeSelections,
  pickBaselineArm,
} from "@/lib/synthesis/quality/ground-truth";
import { type RankHistogram, totalsFromObservations } from "@/lib/synthesis/quality/metrics";
import {
  listQualityCalibrations,
  listQualityProjects,
  loadEvaluableSelections,
} from "@/lib/synthesis/quality/queries";
import { catalogFingerprints, qualitySnapshots } from "@/lib/synthesis/quality/schema";

/**
 * The periodic recompute behind the quality trend.
 *
 * Two jobs, both of which exist because the live tables cannot answer the
 * question on their own:
 *
 *  - `catalog_fingerprints` records what retrieval currently matches on, so a
 *    later "did that edit help?" has a before and an after to sit between. This
 *    is the "trigger when the catalog hash changes": it fires on every pass but
 *    only writes a new row when the corpus actually differs.
 *  - `quality_snapshots` rolls the meter up per day, so a long trend is one
 *    cheap read instead of a rescan of every raw record. (It was also the only
 *    history past thirty days while `otel_logs` was pruned; retention is now
 *    off unless DATA_RETENTION_ENABLED=1, but the archive keeps the trend safe
 *    if it is ever turned back on.)
 *
 * Rows are written per tier in `EVIDENCE_TIERS` (revealed and the answer key).
 * Days rolled up before the answer key existed hold `reference` rows instead;
 * nothing reads those any more, and they are left in place rather than deleted.
 *
 * Runs as an isolated step in the drain: its only readers are behind a flag, so
 * a failure here must degrade the trend, never the drain's retention passes or
 * its job durability.
 */

/**
 * How often the rollup actually does work.
 *
 * Once a day. The snapshot table is an ARCHIVE, not the read path: every figure
 * on the console is recomputed from `otel_logs` on each page load, so nothing a
 * reader sees goes stale between passes. What these rows buy is a cheap,
 * durable history, and history at a finer grain than one day is history nobody
 * asked for.
 *
 * A quarter-hourly pass rewrote the same seven days ninety-six times a day to
 * produce identical rows, which is cost with no reader.
 */
export const QUALITY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How many days back each pass recomputes.
 *
 * Recomputing a week rather than appending yesterday makes the rollup
 * self-healing: late-arriving telemetry, a deploy that missed a pass, and a
 * corrected invocation all fold in on the next run without a backfill script.
 * At one pass a day that redundancy is nearly free, and it is what lets the
 * cadence be this slow safely.
 */
export const QUALITY_ROLLUP_DAYS = 7;

/** How far back to look for projects worth rolling up at all. */
const ACTIVE_PROJECT_WINDOW_DAYS = 30;

/**
 * Cap per pass, so one very busy project cannot monopolise a drain tick.
 *
 * Spent as a ROTATION, never as a cut: see {@link pickProjectsForPass}.
 */
export const MAX_PROJECTS_PER_PASS = 25;

export interface QualitySnapshotResult {
  projectsScanned: number;
  calibrationsRolledUp: number;
  daysWritten: number;
  fingerprintsChanged: number;
  skipped: boolean;
}

export const IDLE_QUALITY_SNAPSHOT: QualitySnapshotResult = {
  projectsScanned: 0,
  calibrationsRolledUp: 0,
  daysWritten: 0,
  fingerprintsChanged: 0,
  skipped: true,
};

export type QualitySnapshotDb = ReturnType<typeof getDb>;

export interface RefreshQualitySnapshotsOptions {
  now?: Date;
  db?: QualitySnapshotDb;
  /** Bypass the interval gate. Used by tests and by a manual recompute. */
  force?: boolean;
}

/** Record catalog fingerprints and roll up the quality meter per day. */
export async function refreshQualitySnapshots(
  options: RefreshQualitySnapshotsOptions = {},
): Promise<QualitySnapshotResult> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDb();

  if (!options.force && !(await isDue(db, now))) {
    return IDLE_QUALITY_SNAPSHOT;
  }

  const activeWindow: ExperimentWindow = {
    since: addDays(startOfUtcDay(now), -ACTIVE_PROJECT_WINDOW_DAYS),
    until: addDays(startOfUtcDay(now), 1),
  };
  const projects = await pickProjectsForPass(await listQualityProjects(activeWindow, db), db);

  let calibrationsRolledUp = 0;
  let daysWritten = 0;
  let fingerprintsChanged = 0;

  for (const project of projects) {
    const { changed, inventory } = await recordCatalogFingerprint(project.projectId, db, now);
    if (changed) fingerprintsChanged += 1;

    const rollupWindow: ExperimentWindow = {
      since: addDays(startOfUtcDay(now), -(QUALITY_ROLLUP_DAYS - 1)),
      until: addDays(startOfUtcDay(now), 1),
    };
    const calibrations = await listQualityCalibrations(project.projectId, rollupWindow, db);

    for (const calibration of calibrations) {
      const { selections } = await loadEvaluableSelections(
        project.projectId,
        calibration.experimentName,
        rollupWindow,
        db,
      );
      if (selections.length === 0) continue;
      calibrationsRolledUp += 1;
      daysWritten += await writeDailyRows(
        project.projectId,
        calibration.experimentName,
        selections,
        inventory.fingerprint,
        db,
        now,
      );
    }
  }

  return {
    projectsScanned: projects.length,
    calibrationsRolledUp,
    daysWritten,
    fingerprintsChanged,
    skipped: false,
  };
}

/**
 * Which projects this pass takes: least recently rolled up first.
 *
 * The cap has to be spent as a rotation rather than a cut. `listQualityProjects`
 * orders by traffic, so taking its first N looks like a per-tick fairness limit
 * and is not one: the same busiest projects win every pass, and a project below
 * the line never gets a snapshot row AT ALL rather than merely getting one late,
 * leaving its trend permanently empty. Ordering by each project's last rollup
 * gives everyone a turn, and a project that has never been rolled up sorts
 * first. Ties keep the traffic order, so the choice is stable across passes.
 *
 * A project's turn coming round every few days is safe because each pass
 * recomputes {@link QUALITY_ROLLUP_DAYS} of history rather than appending
 * yesterday, so a missed turn heals on the next one.
 */
async function pickProjectsForPass<T extends { projectId: string }>(
  projects: readonly T[],
  db: QualitySnapshotDb,
): Promise<T[]> {
  if (projects.length <= MAX_PROJECTS_PER_PASS) return [...projects];

  return projectsForPass(
    projects,
    await lastRollupByProject(
      projects.map((project) => project.projectId),
      db,
    ),
  );
}

/** The ordering half of {@link pickProjectsForPass}, kept pure to be tested. */
export function projectsForPass<T extends { projectId: string }>(
  projects: readonly T[],
  lastRollup: ReadonlyMap<string, Date>,
  cap: number = MAX_PROJECTS_PER_PASS,
): T[] {
  return [...projects]
    .sort(
      (left, right) =>
        // Never rolled up sorts to zero, which is before every real timestamp.
        (lastRollup.get(left.projectId)?.getTime() ?? 0) -
        (lastRollup.get(right.projectId)?.getTime() ?? 0),
    )
    .slice(0, cap);
}

/** When each of these projects was last rolled up. Absent means never. */
async function lastRollupByProject(
  projectIds: readonly string[],
  db: QualitySnapshotDb,
): Promise<Map<string, Date>> {
  const lastRollup = new Map<string, Date>();
  if (projectIds.length === 0) return lastRollup;

  const rows = await db
    .select({
      projectId: qualitySnapshots.projectId,
      computedAt: sql<Date | string>`max(${qualitySnapshots.computedAt})`,
    })
    .from(qualitySnapshots)
    .where(inArray(qualitySnapshots.projectId, [...projectIds]))
    .groupBy(qualitySnapshots.projectId);

  for (const row of rows) {
    lastRollup.set(row.projectId, toDate(row.computedAt));
  }
  return lastRollup;
}

/**
 * Roll one calibration's selections into per-day, per-arm, per-tier rows.
 *
 * Sums rather than rates, so a multi-day read weights every search equally
 * instead of weighting a quiet Sunday like a busy Tuesday.
 */
async function writeDailyRows(
  projectId: string,
  experimentName: string,
  selections: readonly EvaluableSelection[],
  fingerprint: string,
  db: QualitySnapshotDb,
  now: Date,
): Promise<number> {
  const baselineArm = pickBaselineArm(selections);
  if (baselineArm === null) return 0;

  const byDay = new Map<number, EvaluableSelection[]>();
  for (const selection of selections) {
    const day = startOfUtcDay(selection.occurredAt).getTime();
    const bucket = byDay.get(day);
    if (bucket) bucket.push(selection);
    else byDay.set(day, [selection]);
  }

  const rows: (typeof qualitySnapshots.$inferInsert)[] = [];
  for (const [day, daySelections] of byDay) {
    for (const tier of EVIDENCE_TIERS) {
      const grouped = byArm(observeSelections(daySelections, tier, baselineArm));
      for (const [arm, observations] of grouped) {
        const totals = totalsFromObservations(observations);
        if (totals.n === 0) continue;
        rows.push({
          projectId,
          experimentName,
          arm,
          tier,
          day: new Date(day),
          n: totals.n,
          contained: totals.contained,
          creditSum: totals.creditSum,
          reciprocalSum: totals.reciprocalSum,
          rankHistogram: totals.rankHistogram,
          fingerprint,
          computedAt: now,
        });
      }
    }
  }
  if (rows.length === 0) return 0;

  await db
    .insert(qualitySnapshots)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        qualitySnapshots.projectId,
        qualitySnapshots.experimentName,
        qualitySnapshots.arm,
        qualitySnapshots.tier,
        qualitySnapshots.day,
      ],
      // A recompute replaces the day outright rather than accumulating: the
      // pass reads the whole day every time, so adding to what is there would
      // double-count everything each quarter of an hour.
      set: {
        n: sql`excluded.n`,
        contained: sql`excluded.contained`,
        creditSum: sql`excluded.credit_sum`,
        reciprocalSum: sql`excluded.reciprocal_sum`,
        rankHistogram: sql`excluded.rank_histogram`,
        fingerprint: sql`excluded.fingerprint`,
        computedAt: sql`excluded.computed_at`,
      },
    });
  return rows.length;
}

/** Whether enough time has passed since the last pass to do the work again. */
async function isDue(db: QualitySnapshotDb, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ computedAt: sql<Date | string | null>`max(${qualitySnapshots.computedAt})` })
    .from(qualitySnapshots);
  const last = row?.computedAt == null ? null : toDate(row.computedAt);
  if (last === null) return true;
  return now.getTime() - last.getTime() >= QUALITY_REFRESH_INTERVAL_MS;
}

export interface QualityTrendRow {
  day: Date;
  arm: string;
  tier: string;
  n: number;
  contained: number;
  creditSum: number;
  reciprocalSum: number;
  /**
   * Searches by rank, as stored. Optional so hand-built rows keep type-checking;
   * when present, the trend re-derives credit from it under the current curve.
   */
  rankHistogram?: RankHistogram;
  fingerprint: string | null;
}

/** Read the stored trend for one calibration. */
export async function loadQualityTrend(
  projectId: string,
  experimentName: string,
  window: ExperimentWindow,
  db: Pick<QualitySnapshotDb, "select"> = getDb(),
): Promise<QualityTrendRow[]> {
  const rows = await db
    .select({
      day: qualitySnapshots.day,
      arm: qualitySnapshots.arm,
      tier: qualitySnapshots.tier,
      n: qualitySnapshots.n,
      contained: qualitySnapshots.contained,
      creditSum: qualitySnapshots.creditSum,
      reciprocalSum: qualitySnapshots.reciprocalSum,
      rankHistogram: qualitySnapshots.rankHistogram,
      fingerprint: qualitySnapshots.fingerprint,
    })
    .from(qualitySnapshots)
    .where(
      and(
        eq(qualitySnapshots.projectId, projectId),
        eq(qualitySnapshots.experimentName, experimentName),
        gte(qualitySnapshots.day, startOfUtcDay(window.since)),
        lte(qualitySnapshots.day, startOfUtcDay(window.until)),
      ),
    )
    .orderBy(qualitySnapshots.day, qualitySnapshots.arm);

  return rows.map((row) => ({ ...row, day: toDate(row.day) }));
}

export interface CatalogFingerprintChange {
  fingerprint: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  entryCount: number;
  overriddenCount: number;
  distinctCount: number;
}

/** Corpus changes in a window, to mark on the trend. */
export async function loadFingerprintChanges(
  projectId: string,
  window: ExperimentWindow,
  db: Pick<QualitySnapshotDb, "select"> = getDb(),
  limit = 50,
): Promise<CatalogFingerprintChange[]> {
  const rows = await db
    .select({
      fingerprint: catalogFingerprints.fingerprint,
      firstSeenAt: catalogFingerprints.firstSeenAt,
      lastSeenAt: catalogFingerprints.lastSeenAt,
      entryCount: catalogFingerprints.entryCount,
      overriddenCount: catalogFingerprints.overriddenCount,
      distinctCount: catalogFingerprints.distinctCount,
    })
    .from(catalogFingerprints)
    .where(
      and(
        eq(catalogFingerprints.projectId, projectId),
        gte(catalogFingerprints.lastSeenAt, window.since),
      ),
    )
    .orderBy(desc(catalogFingerprints.firstSeenAt))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    firstSeenAt: toDate(row.firstSeenAt),
    lastSeenAt: toDate(row.lastSeenAt),
  }));
}

/**
 * When this project's first fingerprint was recorded, or null if never.
 *
 * The trend needs it to tell an edit from the day we started looking. It cannot
 * come from {@link loadFingerprintChanges}, which is windowed, so the oldest row
 * that read returns is only the oldest one it loaded.
 */
export async function loadFirstFingerprintAt(
  projectId: string,
  db: Pick<QualitySnapshotDb, "select"> = getDb(),
): Promise<Date | null> {
  const [row] = await db
    .select({
      firstSeenAt: sql<Date | string | null>`min(${catalogFingerprints.firstSeenAt})`,
    })
    .from(catalogFingerprints)
    .where(eq(catalogFingerprints.projectId, projectId));

  return row?.firstSeenAt == null ? null : toDate(row.firstSeenAt);
}

export function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
