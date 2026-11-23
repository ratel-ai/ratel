import type { IssueHarm } from "@/lib/readings/trace-signals/health-score";

/**
 * The measured half of the Health score as numbers only: the five rates, their
 * weights, labels and what a reading of them scores. No reading of stored runs
 * here (that is `health-outcomes.ts`), so the score's words and gains can be
 * worked out anywhere, MCP Apps views included. `health-outcomes.ts`
 * re-exports all of it.
 */

export type OutcomePillar = "ended" | "top_5" | "corrections" | "tasks" | "calls";

export const OUTCOME_PILLARS: readonly OutcomePillar[] = [
  "ended",
  "top_5",
  "corrections",
  "tasks",
  "calls",
];

/** Each rate's share of the measured half, before a missing one's weight is shared out. */
export const PILLAR_WEIGHT: Readonly<Record<OutcomePillar, number>> = {
  ended: 0.35,
  top_5: 0.2,
  corrections: 0.2,
  tasks: 0.15,
  calls: 0.1,
};

/** Where a rate's missing points show in the "where the points go" bar. */
export const PILLAR_LEVEL: Readonly<Record<OutcomePillar, IssueHarm>> = {
  ended: "breaks",
  tasks: "breaks",
  top_5: "misleads",
  corrections: "misleads",
  calls: "wastes",
};

export const PILLAR_LABEL: Readonly<Record<OutcomePillar, string>> = {
  ended: "Runs end well",
  top_5: "Right tool in top 5",
  corrections: "No self-corrections",
  tasks: "Tasks finish",
  calls: "Calls work",
};

/** Observations a rate needs before it counts. */
export const OUTCOME_FLOOR = 20;

/** What a self-correction the agent recovered from costs, against one it did not. */
export const RECOVERED_COST = 0.5;

export interface PillarReading {
  pillar: OutcomePillar;
  /** Share of good outcomes, in [0, 1]. */
  good: number;
  /** Observations behind it. */
  n: number;
}

/** The measured half as a score from 0 to 100, exact; null when no rate has enough evidence. */
export function outcomeScore(pillars: readonly PillarReading[]): number | null {
  const weight = pillars.reduce((sum, reading) => sum + PILLAR_WEIGHT[reading.pillar], 0);
  if (weight <= 0) return null;
  return (
    (100 *
      pillars.reduce((sum, reading) => sum + PILLAR_WEIGHT[reading.pillar] * reading.good, 0)) /
    weight
  );
}

/** Each rate's missing points out of 100 on the measured half (they add up to `100 − outcomeScore`). */
export function outcomeLost(pillars: readonly PillarReading[]): Map<OutcomePillar, number> {
  const weight = pillars.reduce((sum, reading) => sum + PILLAR_WEIGHT[reading.pillar], 0);
  return new Map(
    pillars.map((reading) => [
      reading.pillar,
      weight > 0 ? (100 * PILLAR_WEIGHT[reading.pillar] * (1 - reading.good)) / weight : 0,
    ]),
  );
}
