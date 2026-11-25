import { DotSpark } from "@ratel/design-system/dot-matrix";
import { Calculating } from "@/components/console/health/v2/Calculating";
import { ScoreChange, ScoreRing } from "@/components/console/health/v2/HealthScore";
import { scoreCopy } from "@/components/console/health/v2/health-score-model";
import type { HealthScoreView } from "@/lib/readings/trace-signals/health-score";
import type { EarlyProgress } from "@/lib/readings/trace-signals/signals/early-reading";

/** The Health score alone: the ring, what it means, and where it is going. What costs points is below it. */
export function FocusedScore({
  score,
  early,
  progress,
}: {
  score: HealthScoreView;
  /** The reading is early: the score is provisional, so no change and no trend. */
  early: boolean;
  progress: EarlyProgress | null;
}) {
  const copy = scoreCopy(score);
  return (
    <section
      aria-label="Health score"
      data-health-score={score.value}
      className="flex flex-col gap-6 rounded-lg border border-line bg-raised p-5 sm:flex-row sm:items-center sm:gap-8 sm:p-6"
    >
      <ScoreRing
        value={score.value}
        target={null}
        tone={copy.tone}
        band={copy.band}
        calculating={early}
      />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-fg">Health score</h2>
          {early ? <Calculating progress={progress} /> : null}
        </div>
        <p className="text-xl font-semibold tracking-tight text-fg">{copy.headline}</p>
        {early ? null : (
          <div className="flex flex-wrap items-center gap-3">
            <ScoreChange change={copy.change} />
            {/* A trend needs a few readings; two would read as a glitch. */}
            {score.trend.length >= 3 ? (
              <DotSpark
                values={score.trend}
                rows={6}
                label={`Health score over the last ${score.trend.length} readings`}
              />
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
