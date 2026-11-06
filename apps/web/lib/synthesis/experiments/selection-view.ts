import type { SelectionLogRecord } from "./calibration-types";

const COMPARISON_EVENT = "ratel.experiment.comparison";
const RESULTS_EVENT = "ratel.experiment.results";
const RESULT_IDS = "ratel.experiment.result_ids";
const RESULT_SCORES = "ratel.experiment.result_scores";
const QUERY = "ratel.experiment.query";
const SERVED_ARM = "ratel.experiment.served.arm";
const SERVED_OUTCOME = "ratel.experiment.served.outcome";
const SERVED_DURATION_MS = "ratel.experiment.served.duration_ms";
const SERVED_HIT_COUNT = "ratel.experiment.served.hit_count";
const SHADOW_ARM = "ratel.experiment.shadow.arm";
const SHADOW_OUTCOME = "ratel.experiment.shadow.outcome";
const SHADOW_DURATION_MS = "ratel.experiment.shadow.duration_ms";
const SHADOW_HIT_COUNT = "ratel.experiment.shadow.hit_count";
const AGREEMENT_TOP1 = "ratel.experiment.agreement.top1";
const AGREEMENT_EXACT_ORDER = "ratel.experiment.agreement.exact_order";
const AGREEMENT_OVERLAP_COUNT = "ratel.experiment.agreement.overlap_count";
const AGREEMENT_JACCARD = "ratel.experiment.agreement.jaccard_at_k";
const AGREEMENT_K = "ratel.experiment.agreement.k";

export interface SelectionRankingView {
  occurredAt: Date;
  query: string | null;
  servedArm: string | null;
  shadowArm: string | null;
  servedOutcome: string | null;
  shadowOutcome: string | null;
  servedDurationMs: number | null;
  shadowDurationMs: number | null;
  servedHitCount: number | null;
  shadowHitCount: number | null;
  top1: boolean | null;
  exactOrder: boolean | null;
  overlapCount: number | null;
  jaccardAtK: number | null;
  agreementK: number | null;
  servedResultIds: string[] | null;
  shadowResultIds: string[] | null;
  servedResultScores: number[] | null;
  shadowResultScores: number[] | null;
}

/**
 * The query text a selection was made for, from whichever of its records carries
 * it. The comparison record is the usual source, but a skipped or dropped shadow
 * never produces one, and those selections are exactly the ones worth
 * reproducing by hand, so the query is read off any lifecycle record that has it
 * rather than only off the comparison.
 */
export function selectionQuery(records: SelectionLogRecord[]): string | null {
  for (const record of records) {
    const query = emptyToNull(attrString(record.experimentAttrs, QUERY));
    if (query !== null) return query;
  }
  return null;
}

/** Fold a selection's log records into the inspector's ranking view. */
export function buildSelectionRankingView(
  records: SelectionLogRecord[],
): SelectionRankingView | null {
  const comparison = records.find((candidate) => candidate.eventName === COMPARISON_EVENT);
  if (!comparison) return null;
  const attrs = comparison.experimentAttrs;
  const servedArm = emptyToNull(attrString(attrs, SERVED_ARM));
  // Comparison records are attributed to the shadow arm, so the record's own
  // promoted arm stands in when the attr is absent (mirrors shadowArmColumn()
  // in the SQL layer).
  const shadowArm = emptyToNull(attrString(attrs, SHADOW_ARM)) ?? emptyToNull(comparison.arm);
  const servedResults = armResults(records, servedArm);
  const shadowResults = armResults(records, shadowArm);
  return {
    occurredAt: comparison.occurredAt,
    query: attrString(attrs, QUERY),
    servedArm,
    shadowArm,
    servedOutcome: attrString(attrs, SERVED_OUTCOME),
    shadowOutcome: attrString(attrs, SHADOW_OUTCOME),
    servedDurationMs: attrNumber(attrs, SERVED_DURATION_MS),
    shadowDurationMs: attrNumber(attrs, SHADOW_DURATION_MS),
    servedHitCount: attrNumber(attrs, SERVED_HIT_COUNT),
    shadowHitCount: attrNumber(attrs, SHADOW_HIT_COUNT),
    top1: attrBoolean(attrs, AGREEMENT_TOP1),
    exactOrder: attrBoolean(attrs, AGREEMENT_EXACT_ORDER),
    overlapCount: attrNumber(attrs, AGREEMENT_OVERLAP_COUNT),
    jaccardAtK: attrNumber(attrs, AGREEMENT_JACCARD),
    agreementK: attrNumber(attrs, AGREEMENT_K),
    servedResultIds: servedResults.ids,
    shadowResultIds: shadowResults.ids,
    servedResultScores: servedResults.scores,
    shadowResultScores: shadowResults.scores,
  };
}

function armResults(
  records: SelectionLogRecord[],
  arm: string | null,
): { ids: string[] | null; scores: number[] | null } {
  const results =
    arm === null
      ? undefined
      : records.find((candidate) => candidate.eventName === RESULTS_EVENT && candidate.arm === arm);
  if (!results) return { ids: null, scores: null };
  return {
    ids: attrStringArray(results.experimentAttrs, RESULT_IDS),
    scores: attrNumberArray(results.experimentAttrs, RESULT_SCORES),
  };
}

function attrStringArray(attrs: Record<string, unknown>, key: string): string[] | null {
  const value = attrs[key];
  if (!Array.isArray(value)) return null;
  return value.filter((element): element is string => typeof element === "string");
}

function attrNumberArray(attrs: Record<string, unknown>, key: string): number[] | null {
  const value = attrs[key];
  if (!Array.isArray(value)) return null;
  return value.filter(
    (element): element is number => typeof element === "number" && Number.isFinite(element),
  );
}

function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function attrString(attrs: Record<string, unknown>, key: string): string | null {
  const value = attrs[key];
  return typeof value === "string" ? value : null;
}

function attrNumber(attrs: Record<string, unknown>, key: string): number | null {
  const value = attrs[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function attrBoolean(attrs: Record<string, unknown>, key: string): boolean | null {
  const value = attrs[key];
  return typeof value === "boolean" ? value : null;
}
