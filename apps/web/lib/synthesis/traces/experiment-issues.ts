import type {
  ExperimentIssue,
  ExperimentIssueKind,
  ExperimentIssueSeverity,
} from "@/lib/synthesis/experiments/types";
import { buildTraceHref } from "./trace-href";

export interface ExperimentIssueCardContext {
  experimentName: string;
  traceRoot?: string;
  project?: string;
  range?: string;
  from?: string;
  to?: string;
}

export interface ExperimentIssueCardView {
  kind: ExperimentIssueKind;
  severity: ExperimentIssueSeverity;
  title: string;
  detail: string;
  evidenceLabel: string;
  evidenceHref: string;
}

const ISSUE_TITLES: Record<ExperimentIssueKind, string> = {
  capability_absent: "Capability absent",
  ranking_divergence: "Capability ranking changed",
  arm_imbalance: "Arm sample sizes imbalanced",
  error_rate_delta: "Error rate changed",
  latency_delta: "P95 latency changed",
  missing_arm: "Experiment arm missing",
  low_sample: "Low sample size",
};

const SEVERITY_ORDER: Record<ExperimentIssueSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function buildExperimentIssueCards(
  issues: readonly ExperimentIssue[],
  context: ExperimentIssueCardContext,
): ExperimentIssueCardView[] {
  return [...issues].sort(compareIssues).map((issue) => ({
    kind: issue.kind,
    severity: issue.severity,
    title: ISSUE_TITLES[issue.kind],
    detail: buildIssueDetail(issue),
    evidenceLabel: issue.arm ? `View ${issue.arm} traces` : "View experiment traces",
    evidenceHref: buildEvidenceHref(context, issue.arm),
  }));
}

function buildIssueDetail(issue: ExperimentIssue): string {
  if (issue.kind === "error_rate_delta") {
    const direction = issue.delta > 0 ? "higher" : "lower";
    const percentagePoints = formatRoundedNumber(Math.abs(issue.delta) * 100);
    return `${issue.arm} error rate is ${percentagePoints} percentage points ${direction} than baseline`;
  }

  if (issue.kind === "latency_delta") {
    const direction = issue.relativeDelta > 0 ? "higher" : "lower";
    const percentage = formatRoundedNumber(Math.abs(issue.relativeDelta) * 100);
    return `${issue.arm} p95 latency is ${percentage}% ${direction} than baseline`;
  }

  if (issue.kind === "ranking_divergence") {
    const direction = issue.rankDelta > 0 ? "lower" : "higher";
    const places = formatRoundedNumber(Math.abs(issue.rankDelta));
    return `${issue.arm} ranks ${issue.capabilityType} ${issue.capabilityId} ${places} places ${direction} than baseline`;
  }

  return issue.message;
}

function formatRoundedNumber(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function compareIssues(left: ExperimentIssue, right: ExperimentIssue): number {
  const severityOrder = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (severityOrder !== 0) return severityOrder;

  const kindOrder = compareText(left.kind, right.kind);
  if (kindOrder !== 0) return kindOrder;

  const armOrder = compareText(left.arm ?? "", right.arm ?? "");
  if (armOrder !== 0) return armOrder;

  return compareText(left.message, right.message);
}

function buildEvidenceHref(context: ExperimentIssueCardContext, arm: string | null): string {
  const params = new URLSearchParams();
  appendParam(params, "project", context.project);
  appendParam(params, "range", context.range);
  appendParam(params, "from", context.from);
  appendParam(params, "to", context.to);
  appendExactParam(params, "experiment", context.experimentName);
  appendExactParam(params, "arm", arm);
  params.set("exactTags", "1");
  return buildTraceHref(context.traceRoot ?? "/traces", "", `?${params.toString()}`);
}

function appendParam(params: URLSearchParams, key: string, value: string | null | undefined): void {
  const normalized = value?.trim();
  if (normalized) params.set(key, normalized);
}

function appendExactParam(
  params: URLSearchParams,
  key: string,
  value: string | null | undefined,
): void {
  if (value) params.set(key, value);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
