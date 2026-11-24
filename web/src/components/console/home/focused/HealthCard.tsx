import { Section } from "@ratel/design-system/section";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { ScoreChange, ScoreRing } from "@/components/console/health/v2/HealthScore";
import { scoreCopy } from "@/components/console/health/v2/health-score-model";
import type { FocusedHealth, HealthCard as HealthCardModel } from "@/lib/views/home/focused-load";

/** The Health score on Overview: the ring, its change and where the points go. The whole card opens Agent health. */
export function HealthCard({ health, window }: { health: FocusedHealth; window: number }) {
  const { card, href, windowDays } = health;
  return (
    <Section title="Health score">
      <Link
        href={href}
        data-overview-health={card.kind}
        className="group flex flex-col gap-4 rounded-lg border border-line bg-raised p-5 outline-none transition-colors duration-120 hover:border-line-strong focus-visible:ring-2 focus-visible:ring-focus"
      >
        {card.kind === "score" ? <Score card={card} /> : <State card={card} />}
        <span className="flex items-center justify-between gap-3 border-t border-line pt-3 text-xs text-fg-subtle">
          <span>
            {windowDays < window
              ? `Last ${windowDays} days, the most your plan reads`
              : `Last ${windowDays} days`}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-fg-muted group-hover:text-fg">
            Agent health
            <ArrowRight aria-hidden className="size-3.5" />
          </span>
        </span>
      </Link>
    </Section>
  );
}

function Score({ card }: { card: Extract<HealthCardModel, { kind: "score" }> }) {
  const copy = scoreCopy(card.score);
  return (
    <div
      className="flex flex-col items-center gap-5 sm:flex-row sm:gap-8"
      data-health-score={card.score.value}
    >
      <ScoreRing
        value={card.score.value}
        target={null}
        tone={copy.tone}
        band={copy.band}
        calculating={card.early}
      />
      <div className="flex w-full min-w-0 flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 sm:justify-start">
          <p className="text-xl font-semibold tracking-tight text-fg">{copy.headline}</p>
          {card.early ? (
            <span className="text-ui text-fg-subtle">A first look, still calculating</span>
          ) : (
            <ScoreChange change={copy.change} />
          )}
        </div>
        <ul
          className="grid gap-x-10 gap-y-2 text-ui lg:grid-cols-2"
          aria-label="Where the missing points go"
        >
          {card.lost.map(({ level, label, lost }) => (
            <li
              key={level}
              className="flex items-center justify-between gap-3"
              data-health-lost={level}
            >
              <span className="text-fg-muted">{label}</span>
              <span className={lost ? "text-fg tabular-nums" : "text-fg-subtle tabular-nums"}>
                {lost ? `\u2212${lost} pts` : "0"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function State({ card }: { card: Extract<HealthCardModel, { kind: "state" }> }) {
  return (
    <p className={card.failed ? "text-sm text-danger" : "text-sm text-fg-muted"}>{card.line}</p>
  );
}
