import {
  explainQualityGap,
  type QualityGap,
  type QualityScore,
} from "@/lib/synthesis/quality/metrics";
import type { ArmQuality, TierQuality } from "@/lib/synthesis/quality/service";

/**
 * Which figures lead the quality surfaces, decided once for the console and the
 * partner report so the two can never disagree about what they claim.
 *
 * The headline is accuracy against a KNOWN answer, never against the incumbent's
 * own list. The answer key (`judged`) leads because it covers far more searches
 * than invocation attribution does; the revealed tier (the tool the agent ran)
 * only leads when the key has not read anything in this window yet. With
 * neither, there is no headline, and the surface says so instead of inventing
 * one.
 */

/** The share of evaluable searches where the answer came first. */
export function topOneShare(score: QualityScore): number | null {
  if (score.n === 0) return null;
  return (score.rankHistogram["1"] ?? 0) / score.n;
}

export interface QualityHeadlineChoice {
  /** The tier every headline figure is taken from. */
  tier: TierQuality;
  subject: ArmQuality;
  /** The baseline on the same population, or null when it cannot be compared. */
  baseline: ArmQuality | null;
  /** Only on a comparable tier, where both arms sit on the same searches. */
  gap: QualityGap | null;
}

/** Headline tiers, most searches covered first. */
const HEADLINE_ORDER = ["judged", "revealed"] as const;

export function pickHeadline(
  tiers: readonly TierQuality[],
  subjectArm: string | undefined,
): QualityHeadlineChoice | null {
  if (subjectArm === undefined) return null;
  for (const name of HEADLINE_ORDER) {
    const tier = tiers.find((candidate) => candidate.tier === name);
    const subject = tier?.arms.find((arm) => arm.arm === subjectArm);
    if (!tier || !subject || subject.score.n === 0) continue;
    // The tool the agent ran was picked from whatever list SERVED the search, so
    // an arm that served is graded against its own pick: 100% by construction.
    // Only an arm that shadowed every one of these searches may headline on it.
    if (name === "revealed" && subject.bias !== "independent") continue;
    const baselineRow = tier.arms.find(
      (arm) => arm.arm === tier.baselineArm && arm.arm !== subjectArm,
    );
    const baseline = tier.comparable && baselineRow ? baselineRow : null;
    return {
      tier,
      subject,
      baseline,
      gap: baseline ? explainQualityGap(subject.score, baseline.score) : null,
    };
  }
  return null;
}
