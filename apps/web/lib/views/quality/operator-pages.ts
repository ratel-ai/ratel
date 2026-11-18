import { notFound } from "next/navigation";
import type { ComponentType, ReactNode } from "react";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import type { ExperimentWindow } from "@/lib/synthesis/experiments/service";
import {
  countComparisonsPerWindow,
  listQualityCalibrations,
} from "@/lib/synthesis/quality/queries";
import {
  listQualityProjectSummaries,
  loadQualityView,
  type QualityProjectSummary,
  type QualityView,
} from "@/lib/synthesis/quality/service";
import {
  type CatalogFingerprintChange,
  loadFingerprintChanges,
  loadFirstFingerprintAt,
  loadQualityTrend,
  type QualityTrendRow,
} from "@/lib/synthesis/quality/snapshot";
import { parseWindowDays, resolveQualityWindow } from "@/lib/synthesis/quality/window";
import { type OperatorConsole, operatorConsole } from "@/lib/views/quality/operator-console";

/**
 * The reads behind the operator's Quality pages (`/admin/quality`), which upstream's admin console
 * made itself behind its platform-admin gate. Here the core draws the pages and the edition's
 * operator console gates and frames them: no console is a 404 before anything is read, and
 * `authorize` runs before any read. The cross-tenant list is imported here and nowhere else
 * (pinned by `operator-reach.test.ts`).
 */

/**
 * Offered windows. Telemetry is no longer pruned, but a project only has as much history as it
 * has been sending, and 90 makes that edge visible.
 */
export const QUALITY_WINDOW_OPTIONS: readonly number[] = [7, 14, 30, 90];

type Calibration = { experimentName: string; comparisonCount: number };

export type OperatorQualityReads = {
  listQualityProjectSummaries(window: ExperimentWindow): Promise<QualityProjectSummary[]>;
  listQualityCalibrations(projectId: string, window: ExperimentWindow): Promise<Calibration[]>;
  loadQualityView(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
  ): Promise<QualityView | null>;
  loadQualityTrend(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
  ): Promise<QualityTrendRow[]>;
  loadFingerprintChanges(
    projectId: string,
    window: ExperimentWindow,
  ): Promise<CatalogFingerprintChange[]>;
  loadFirstFingerprintAt(projectId: string): Promise<Date | null>;
  countComparisonsPerWindow(
    projectId: string,
    experimentName: string,
    windows: readonly number[],
  ): Promise<{ counts: Map<number, number>; earliest: Date | null }>;
};

export type OperatorQualityDeps = {
  operatorConsole(): Promise<OperatorConsole | undefined>;
  isDbConfigured(): boolean;
  /** Called only once the reader is authorized, so not even a connection opens before. */
  reads(): OperatorQualityReads;
};

export function operatorQualityDeps(): OperatorQualityDeps {
  return {
    operatorConsole,
    isDbConfigured,
    reads: () => {
      const db = getDb();
      return {
        listQualityProjectSummaries: (window) => listQualityProjectSummaries(window, db),
        listQualityCalibrations: (projectId, window) =>
          listQualityCalibrations(projectId, window, db),
        loadQualityView: (projectId, experimentName, window) =>
          loadQualityView(projectId, experimentName, window, db),
        loadQualityTrend: (projectId, experimentName, window) =>
          loadQualityTrend(projectId, experimentName, window, db),
        loadFingerprintChanges: (projectId, window) =>
          loadFingerprintChanges(projectId, window, db),
        loadFirstFingerprintAt: (projectId) => loadFirstFingerprintAt(projectId, db),
        countComparisonsPerWindow: (projectId, experimentName, windows) =>
          countComparisonsPerWindow(projectId, experimentName, windows, db),
      };
    },
  };
}

type Framed = { Frame: ComponentType<{ children: ReactNode }> };

/** The console, once its reader is authorized; a 404 in an edition without one. */
async function authorizedConsole(deps: OperatorQualityDeps): Promise<OperatorConsole> {
  const operator = await deps.operatorConsole();
  if (!operator) notFound();
  await operator.authorize();
  return operator;
}

export type OperatorQualityIndex = Framed &
  (
    | { state: "no-database" }
    | { state: "ready"; windowDays: number; projects: QualityProjectSummary[] }
  );

/** The index: every project running a shadow calibration in the window. */
export async function loadOperatorQualityIndex(
  days: string | undefined,
  deps: OperatorQualityDeps = operatorQualityDeps(),
): Promise<OperatorQualityIndex> {
  const { Frame } = await authorizedConsole(deps);
  if (!deps.isDbConfigured()) return { Frame, state: "no-database" };
  const projects = await deps.reads().listQualityProjectSummaries(resolveQualityWindow(days));
  return { Frame, state: "ready", windowDays: parseWindowDays(days), projects };
}

export type OperatorQualityDetail = Framed &
  (
    | { state: "no-database" }
    | { state: "no-calibration"; windowDays: number }
    | {
        state: "ready";
        projectId: string;
        experimentName: string;
        window: ExperimentWindow;
        windowDays: number;
        calibrations: Calibration[];
        view: QualityView;
        trend: QualityTrendRow[];
        fingerprintChanges: CatalogFingerprintChange[];
        firstFingerprintAt: Date | null;
        windowCounts: { counts: Map<number, number>; earliest: Date | null };
      }
  );

/** One calibration's quality, in full; a 404 for a project with no view. */
export async function loadOperatorQualityDetail(
  projectId: string,
  search: { days?: string; calibration?: string },
  deps: OperatorQualityDeps = operatorQualityDeps(),
): Promise<OperatorQualityDetail> {
  const { Frame } = await authorizedConsole(deps);
  if (!deps.isDbConfigured()) return { Frame, state: "no-database" };

  const window = resolveQualityWindow(search.days);
  const windowDays = parseWindowDays(search.days);
  const reads = deps.reads();
  const calibrations = await reads.listQualityCalibrations(projectId, window);
  const experimentName = search.calibration ?? calibrations[0]?.experimentName;
  if (!experimentName) return { Frame, state: "no-calibration", windowDays };

  const [view, trend, fingerprintChanges, firstFingerprintAt, windowCounts] = await Promise.all([
    reads.loadQualityView(projectId, experimentName, window),
    reads.loadQualityTrend(projectId, experimentName, window),
    reads.loadFingerprintChanges(projectId, window),
    reads.loadFirstFingerprintAt(projectId),
    reads.countComparisonsPerWindow(projectId, experimentName, QUALITY_WINDOW_OPTIONS),
  ]);
  if (!view) notFound();

  return {
    Frame,
    state: "ready",
    projectId,
    experimentName,
    window,
    windowDays,
    calibrations,
    view,
    trend,
    fingerprintChanges,
    firstFingerprintAt,
    windowCounts,
  };
}
