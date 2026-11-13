import type { CapabilityComparison, ExperimentSummary } from "@/lib/synthesis/experiments/types";

interface ArmNamed {
  arm: string;
}

const EXPERIMENT_SEGMENT_PREFIX = "~";

export function experimentDetailPath(name: string): string {
  return `/experiments/${EXPERIMENT_SEGMENT_PREFIX}${encodeURIComponent(name)}`;
}

/**
 * Next decodes dynamic path params before handing them to the page. The prefix
 * keeps "." and ".." from becoming URL dot-segments while remaining reversible.
 */
export function experimentNameFromPathSegment(segment: string): string {
  return segment.startsWith(EXPERIMENT_SEGMENT_PREFIX)
    ? segment.slice(EXPERIMENT_SEGMENT_PREFIX.length)
    : segment;
}

export function displayCapabilityRank(value: number | null): number | null {
  return value === null ? null : value + 1;
}

export function selectVisibleArms<T extends ArmNamed>(
  arms: readonly T[],
  baselineArm: string,
  limit = 3,
): T[] {
  if (limit <= 0) return [];
  const baseline = arms.find(({ arm }) => arm === baselineArm);
  if (!baseline) return arms.slice(0, limit);
  return [baseline, ...arms.filter(({ arm }) => arm !== baselineArm)].slice(0, limit);
}

/**
 * The role label shown under an arm's name.
 *
 * Arm names are whatever the SDK reported in `ratel.experiment.arm` — they are
 * data, not roles. The *role* is derived: one arm is picked as the baseline
 * (see `pickBaselineArm`) and every other arm is a variant measured against it.
 * With a single variant "variant" is unambiguous; past that they are numbered in
 * the order they appear so a delta can be traced back to a specific column.
 */
export function armRoleLabel(variantIndex: number, variantCount: number): string {
  if (variantIndex < 0) return "baseline";
  return variantCount > 1 ? `variant ${variantIndex + 1}` : "variant";
}

export function sortCapabilitiesByVisibleDelta(
  rows: readonly CapabilityComparison[],
  visibleArms: readonly string[],
  baselineArm: string,
): CapabilityComparison[] {
  const visible = new Set(visibleArms);
  return [...rows].sort((left, right) => {
    const deltaOrder =
      maximumVisibleDelta(right, visible, baselineArm) -
      maximumVisibleDelta(left, visible, baselineArm);
    return deltaOrder || left.type.localeCompare(right.type) || left.id.localeCompare(right.id);
  });
}

export function selectExperimentBanner(
  experiments: readonly ExperimentSummary[],
  preferredName: string,
): ExperimentSummary | undefined {
  if (preferredName) {
    return experiments.find(({ name }) => name === preferredName);
  }
  return [...experiments].sort(
    (left, right) =>
      right.lastSeenAt.getTime() - left.lastSeenAt.getTime() || left.name.localeCompare(right.name),
  )[0];
}

function maximumVisibleDelta(
  row: CapabilityComparison,
  visibleArms: ReadonlySet<string>,
  baselineArm: string,
): number {
  const deltas = row.arms.flatMap(({ arm, rankDelta }) =>
    arm === baselineArm || !visibleArms.has(arm) || rankDelta === null ? [] : [Math.abs(rankDelta)],
  );
  return deltas.length === 0 ? -1 : Math.max(...deltas);
}
