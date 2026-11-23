import { compareCapabilities } from "./capabilities";
import {
  attachExperimentConversionMetrics,
  attachExperimentLifecycleMetrics,
  compareArmMetrics,
} from "./compare";
import { detectExperiments } from "./detect";
import type { ExperimentDetectionAggregates } from "./fold";
import { detectExperimentIssues } from "./issues";
import type {
  ArmMetricAggregate,
  ArmSearchSpan,
  ExperimentComparison,
  ExperimentConversionMetrics,
  ExperimentLifecycleArmMetrics,
  ExperimentLifecycleDiagnostics,
  ExperimentSummary,
} from "./types";

export interface ExperimentWindow {
  since: Date;
  until: Date;
}

export interface ExperimentComparisonOptions {
  includeLifecycle?: boolean;
}

export interface ExperimentLifecycleData {
  arms: ExperimentLifecycleArmMetrics[];
  diagnostics: ExperimentLifecycleDiagnostics;
}

export interface ExperimentQueries {
  listExperimentDetectionAggregates(
    projectId: string,
    window: ExperimentWindow,
  ): Promise<ExperimentDetectionAggregates>;
  getArmMetricAggregates(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
  ): Promise<ArmMetricAggregate[]>;
  listArmSearchSpans(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
  ): Promise<ArmSearchSpan[]>;
  listExperimentLifecycleArmMetrics?(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
  ): Promise<ExperimentLifecycleArmMetrics[]>;
  getExperimentLifecycleDiagnostics?(
    projectId: string,
    window: ExperimentWindow,
  ): Promise<ExperimentLifecycleDiagnostics>;
  getExperimentConversionMetrics?(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
  ): Promise<ExperimentConversionMetrics>;
}

export function createExperimentService(queries: ExperimentQueries) {
  async function listExperiments(
    projectId: string,
    window: ExperimentWindow,
  ): Promise<ExperimentSummary[]> {
    const { armAggregates, multiArmCounts } = await queries.listExperimentDetectionAggregates(
      projectId,
      window,
    );
    return detectExperiments(armAggregates, multiArmCounts);
  }

  async function getExperimentComparison(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
    options: ExperimentComparisonOptions = {},
  ): Promise<ExperimentComparison | null> {
    const summary = (await listExperiments(projectId, window)).find(
      ({ name }) => name === experimentName,
    );
    if (!summary) return null;

    const [metricAggregates, searchSpans, lifecycle, conversion] = await Promise.all([
      queries.getArmMetricAggregates(projectId, experimentName, window),
      queries.listArmSearchSpans(projectId, experimentName, window),
      options.includeLifecycle
        ? getExperimentLifecycle(projectId, experimentName, window)
        : Promise.resolve(null),
      options.includeLifecycle
        ? getExperimentConversion(projectId, experimentName, window)
        : Promise.resolve(null),
    ]);
    const arms = compareArmMetrics(summary.baselineArm, metricAggregates);
    const capabilities = compareCapabilities(
      summary.baselineArm,
      arms.map(({ arm }) => arm),
      searchSpans,
    );
    const baseline = arms.find(({ arm }) => arm === summary.baselineArm);
    if (!baseline) {
      throw new Error(`Baseline arm "${summary.baselineArm}" has no metrics`);
    }

    return attachExperimentSupplementaryData(
      {
        name: summary.name,
        mode: summary.mode,
        baselineArm: summary.baselineArm,
        arms,
        capabilities,
        issues: detectExperimentIssues(
          baseline,
          arms.filter(({ arm }) => arm !== summary.baselineArm),
          capabilities,
        ),
      },
      lifecycle,
      conversion,
    );
  }

  async function getExperimentLifecycle(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
  ): Promise<ExperimentLifecycleData | null> {
    if (!queries.listExperimentLifecycleArmMetrics || !queries.getExperimentLifecycleDiagnostics) {
      return null;
    }
    const [arms, diagnostics] = await Promise.all([
      queries.listExperimentLifecycleArmMetrics(projectId, experimentName, window),
      queries.getExperimentLifecycleDiagnostics(projectId, window),
    ]);
    return { arms, diagnostics };
  }

  async function getExperimentConversion(
    projectId: string,
    experimentName: string,
    window: ExperimentWindow,
  ): Promise<ExperimentConversionMetrics | null> {
    return queries.getExperimentConversionMetrics
      ? queries.getExperimentConversionMetrics(projectId, experimentName, window)
      : null;
  }

  return {
    listExperiments,
    getExperimentComparison,
    getExperimentLifecycle,
    getExperimentConversion,
  };
}

export function attachExperimentSupplementaryData(
  comparison: ExperimentComparison,
  lifecycle: ExperimentLifecycleData | null,
  conversion: ExperimentConversionMetrics | null,
): ExperimentComparison {
  const lifecycleArms = lifecycle
    ? attachExperimentLifecycleMetrics(comparison.arms, lifecycle.arms)
    : comparison.arms;
  const arms = conversion
    ? attachExperimentConversionMetrics(lifecycleArms, conversion.arms)
    : lifecycleArms;
  return {
    ...comparison,
    arms,
    ...(lifecycle ? { lifecycleDiagnostics: lifecycle.diagnostics } : {}),
    ...(conversion ? { conversionSummary: conversionSummary(conversion) } : {}),
  };
}

function conversionSummary({
  invocationCount,
  attributedInvocationCount,
  unattributedInvocationCount,
  invocationAttributionRate,
  unresolvedOutcomeCount,
}: ExperimentConversionMetrics) {
  return {
    invocationCount,
    attributedInvocationCount,
    unattributedInvocationCount,
    invocationAttributionRate,
    unresolvedOutcomeCount,
  };
}
