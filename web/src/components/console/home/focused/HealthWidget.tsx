import Link from "next/link";
import { ScoreRing } from "@/components/console/health/v2/HealthScore";
import { scoreCopy } from "@/components/console/health/v2/health-score-model";
import { lowConfidenceCopy } from "@/lib/views/health/low-confidence-copy";
import type { FocusedHealth } from "@/lib/views/home/focused-load";

/** The Health score as a gauge: the ring, the number and the band. The whole body opens Agent health. */
export function HealthWidget({ health, window }: { health: FocusedHealth; window: number }) {
  const { card, href, windowDays } = health;
  return (
    <Link
      href={href}
      data-overview-health={card.kind}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto rounded-lg p-4 outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
    >
      <span className="sr-only">Open Agent health</span>
      {card.kind === "score" ? (
        <span data-health-score={card.score.value}>
          <Gauge score={card.score} early={card.early} />
        </span>
      ) : (
        <span
          className={
            card.failed ? "text-center text-sm text-danger" : "text-center text-sm text-fg-muted"
          }
        >
          {card.line}
        </span>
      )}
      {card.kind === "score" && card.lowConfidence ? (
        <span className="text-center text-xs text-fg-subtle">
          {lowConfidenceCopy(card.lowConfidence)}
        </span>
      ) : null}
      {windowDays < window ? (
        <span className="text-center text-xs text-fg-subtle">
          Last {windowDays} days, the most your plan reads
        </span>
      ) : null}
    </Link>
  );
}

function Gauge({ score, early }: { score: Parameters<typeof scoreCopy>[0]; early: boolean }) {
  const copy = scoreCopy(score);
  return (
    <ScoreRing
      value={score.value}
      target={null}
      tone={copy.tone}
      band={copy.band}
      calculating={early}
    />
  );
}
