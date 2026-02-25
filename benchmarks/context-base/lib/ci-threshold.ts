export type ThresholdConfig = Record<string, number>;

export interface EvaliteExportedOutput {
  run: { id: number; runType: string; createdAt: string };
  suites: Array<{
    name: string;
    evals: Array<{
      scores: Array<{ name: string; score: number }>;
    }>;
  }>;
}

export interface ThresholdDetail {
  scorer: string;
  threshold: number;
  average: number;
  passed: boolean;
}

export interface ThresholdCheckResult {
  passed: boolean;
  details: ThresholdDetail[];
}

export function checkThresholds(
  output: EvaliteExportedOutput,
  thresholds: ThresholdConfig,
): ThresholdCheckResult {
  const allScores = output.suites.flatMap((s) =>
    s.evals.flatMap((e) => e.scores),
  );

  const details: ThresholdDetail[] = Object.entries(thresholds).map(
    ([scorer, threshold]) => {
      const scores = allScores
        .filter((s) => s.name === scorer)
        .map((s) => s.score);
      const average =
        scores.length > 0
          ? scores.reduce((sum, s) => sum + s, 0) / scores.length
          : 0;
      return { scorer, threshold, average, passed: average >= threshold };
    },
  );

  return {
    passed: details.every((d) => d.passed),
    details,
  };
}
