import Link from "next/link";
import { ScoreRing } from "@/components/console/health/v2/HealthScore";
import { scoreCopy } from "@/components/console/health/v2/health-score-model";
import { HealthEmpty } from "@/components/console/home/focused/HealthEmpty";
import type { EmptyWindow } from "@/components/console/home/focused/WidgetEmpty";
import { lowConfidenceCopy } from "@/lib/views/health/low-confidence-copy";
import type { FocusedHealth } from "@/lib/views/home/focused-load";

/** The Health score as a gauge: the ring, the number and the band. The whole body opens Agent health. */
export function HealthWidget({ health, at }: { health: FocusedHealth; at: EmptyWindow }) {
  const { card, href, windowDays } = health;
  const capped =
    windowDays < at.window ? `Last ${windowDays} days, the most your plan reads` : undefined;
  if (card.kind === "state")
    return <HealthEmpty card={card} href={href} windowDays={windowDays} at={at} note={capped} />;
  return (
    <Link
      href={href}
      data-overview-health={card.kind}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto rounded-lg p-4 outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
    >
      <span className="sr-only">Open Agent health</span>
      <span data-health-score={card.score.value}>
        <Gauge score={card.score} early={card.early} />
      </span>
      {card.lowConfidence ? (
        <span className="text-center text-xs text-fg-subtle">
          {lowConfidenceCopy(card.lowConfidence)}
        </span>
      ) : null}
      {capped ? <span className="text-center text-xs text-fg-subtle">{capped}</span> : null}
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
