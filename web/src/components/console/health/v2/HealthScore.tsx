import { StatusDot } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { DotMeter, DotSpark } from "@ratel/design-system/dot-matrix";
import { PeekLink } from "@ratel/design-system/panel";
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight } from "lucide-react";
import type { CSSProperties } from "react";
import { SIGNAL_KIND_ICONS } from "@/components/console/health/kinds";
import { Calculating } from "@/components/console/health/v2/Calculating";
import {
  type RingCell,
  ringCells,
  type ScoreTone,
  scoreCopy,
} from "@/components/console/health/v2/health-score-model";
import type { HealthScoreView, IssueHarm } from "@/lib/readings/trace-signals/health-score";
import type { EarlyProgress } from "@/lib/readings/trace-signals/signals/early-reading";
import type { SignalKind } from "@/lib/readings/trace-signals/view";

/**
 * The Health score (RC-225): the one number Agent health leads with.
 *
 * A ring of square pixels lit up to the score in its band's color, the tip
 * in coral (what it is now) and, faint, the pixels the next three fixes
 * would light. Beside it the band in one sentence, the goal those fixes
 * reach, where the missing points go, and the fixes themselves, each a click
 * from its issue. Static on purpose (DESIGN.md, Motion): no count-up, no glow.
 */

/** One of the next fixes, as the hero lists it. */
export interface ScoreFix {
  peek: string;
  title: string;
  kind: SignalKind;
  points: number;
}

const TONE_TEXT: Readonly<Record<ScoreTone, string>> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};
const TONE_BG: Readonly<Record<ScoreTone, string>> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

/** The missing points are gray: only the score itself wears a color. */
const LOST_BG: Readonly<Record<IssueHarm, string>> = {
  breaks: "bg-fg-subtle",
  misleads: "bg-fg-faint",
  wastes: "bg-line-active",
  tidies: "bg-line-strong",
};

export function HealthScore({
  score,
  next = [],
  early = false,
  progress = null,
  shared = false,
  inferredTools = false,
}: {
  score: HealthScoreView;
  next?: readonly ScoreFix[];
  /** The reading is early (RC-224): the ring beats and a wave runs round it. */
  early?: boolean;
  progress?: EarlyProgress | null;
  /** A public link (RC-226): a change is still shown, the team's own "first reading" line is not. */
  shared?: boolean;
  /** The reading's tool calls were inferred from span shape (an importer in privacy mode): the score could not check asks or answers. */
  inferredTools?: boolean;
}) {
  const copy = scoreCopy(score);
  return (
    <section
      aria-label="Health score"
      data-health-score={score.value}
      className="overflow-hidden rounded-lg border border-line bg-raised"
    >
      <div className="flex flex-col gap-6 p-5 sm:flex-row sm:items-center sm:gap-8 sm:p-6">
        <ScoreRing
          value={score.value}
          target={copy.target}
          tone={copy.tone}
          band={copy.band}
          calculating={early}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-fg">Health score</h2>
              {early ? <Calculating progress={progress} /> : null}
            </div>
            <div className="flex items-center gap-3">
              {/* A trend needs a few readings; two would read as a glitch. */}
              {!early && score.trend.length >= 3 ? (
                <DotSpark
                  values={score.trend}
                  rows={6}
                  label={`Health score over the last ${score.trend.length} readings`}
                />
              ) : null}
              {/* An early score is provisional: no change against a full reading until it is one. */}
              {early || (shared && !copy.change) ? null : <ScoreChange change={copy.change} />}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-xl font-semibold tracking-tight text-fg">{copy.headline}</p>
            <p className="text-sm text-fg-muted">
              {copy.goalLead !== null && copy.target !== null ? (
                <>
                  {copy.goalLead}{" "}
                  <span className={cn("font-semibold tabular-nums", TONE_TEXT[copy.tone])}>
                    {copy.target}
                  </span>
                  .
                </>
              ) : (
                copy.goal
              )}
            </p>
          </div>
          <LostBar value={score.value} tone={copy.tone} lost={copy.lost} />
          {copy.parts.length > 0 ? <ScoreParts parts={copy.parts} /> : null}
        </div>
      </div>
      {next.length > 0 ? (
        <div className="border-t border-line px-5 py-4 sm:px-6">
          <NextFixes fixes={next} />
        </div>
      ) : null}
      {inferredTools ? (
        <p
          className="border-t border-line px-5 py-2.5 text-xs text-fg-subtle sm:px-6"
          data-health-score-inferred=""
        >
          Read from tool calls inferred from span shape. Asks and answers are not checked.
        </p>
      ) : null}
      <p className="border-t border-line px-5 py-2.5 text-xs text-fg-subtle sm:px-6">
        {copy.basis}
      </p>
    </section>
  );
}

/** The ring of pixels, the number in its middle, and the band under it. */
export function ScoreRing({
  value,
  target,
  tone,
  band,
  calculating,
}: {
  value: number;
  target: number | null;
  tone: ScoreTone;
  band: string;
  calculating: boolean;
}) {
  const cells = ringCells(value, target);
  const tip = cells.findIndex((cell) => cell.state === "tip");
  return (
    <div className="relative mx-auto size-44 shrink-0 sm:mx-0" data-health-score-ring="">
      <svg
        viewBox="0 0 200 200"
        className={cn("size-full", TONE_TEXT[tone])}
        role="img"
        aria-label={`Health score ${value} of 100, ${band}${calculating ? ", still calculating" : ""}`}
        data-calculating={calculating ? "" : undefined}
      >
        {cells.map((cell, index) => (
          <RingPixel key={index} cell={cell} motion={calculating ? motionOf(index, tip) : null} />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 pt-1">
        <span className="text-5xl leading-none font-semibold tracking-tight text-fg tabular-nums">
          {value}
        </span>
        <span className="text-xs text-fg-subtle tabular-nums">of 100</span>
      </div>
      <div className="absolute inset-x-0 bottom-1 flex justify-center">
        <StatusDot tone={tone} label={band} className="text-ui font-medium text-fg" />
      </div>
    </div>
  );
}

/** The ring before there is a score: no pixel is lit, and nothing moves. Decoration: say why beside it. */
export function EmptyScoreRing() {
  return (
    <span className="relative flex h-full min-h-0" data-health-score-ring="empty">
      <svg viewBox="0 0 200 200" className="h-full max-w-full" aria-hidden>
        {ringCells(0, null).map((cell, index) => (
          <RingPixel key={index} cell={cell} motion={null} />
        ))}
        <path d="M88 100 H112" className="stroke-fg-subtle" strokeWidth={4} />
      </svg>
    </span>
  );
}

const PIXEL = 8;

/** Calculating: the tip beats, and the pixels past it light one after another, round to the end. */
function motionOf(index: number, tip: number): { className: string; delayMs: number } | null {
  if (index === tip) return { className: "score-beat", delayMs: 0 };
  if (index > tip) return { className: "score-wave", delayMs: (index - tip) * 70 };
  return null;
}

function RingPixel({
  cell,
  motion,
}: {
  cell: RingCell;
  motion: { className: string; delayMs: number } | null;
}) {
  const fill =
    cell.state === "lit"
      ? "fill-current"
      : cell.state === "tip"
        ? "fill-accent-mark"
        : cell.state === "target"
          ? "fill-current opacity-30"
          : "fill-line-strong";
  return (
    <rect
      x={cell.x - PIXEL / 2}
      y={cell.y - PIXEL / 2}
      width={PIXEL}
      height={PIXEL}
      rx={1.5}
      transform={`rotate(${cell.angle} ${cell.x} ${cell.y})`}
      className={cn(fill, motion?.className)}
      style={
        motion && motion.delayMs > 0
          ? ({ "--wave-delay": `${motion.delayMs}ms` } as CSSProperties)
          : undefined
      }
      data-ring-cell={cell.state}
    />
  );
}

export function ScoreChange({ change }: { change: ReturnType<typeof scoreCopy>["change"] }) {
  if (!change)
    return <span className="text-ui text-fg-subtle">Your first reading with a score</span>;
  const Icon =
    change.direction === "up"
      ? ArrowUpRight
      : change.direction === "down"
        ? ArrowDownRight
        : ArrowRight;
  const tone =
    change.direction === "up"
      ? "bg-success-subtle text-success"
      : change.direction === "down"
        ? "bg-danger-subtle text-danger"
        : "border border-line text-fg-subtle";
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md px-2 text-ui font-medium tabular-nums",
        tone,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {change.text}
    </span>
  );
}

/** The 100 points as one bar: the score in its color, then each level's missing points in gray, named below. */
function LostBar({
  value,
  tone,
  lost,
}: {
  value: number;
  tone: ScoreTone;
  lost: ReturnType<typeof scoreCopy>["lost"];
}) {
  return (
    <div className="flex flex-col gap-2" data-health-score-lost="">
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-[2px]" aria-hidden>
        {value > 0 ? (
          <span
            className={cn("h-full rounded-[1px]", TONE_BG[tone])}
            style={{ width: `${value}%` }}
          />
        ) : null}
        {lost.map((part) => (
          <span
            key={part.level}
            className={cn("h-full rounded-[1px]", LOST_BG[part.level])}
            style={{ width: `${part.points}%` }}
          />
        ))}
      </div>
      {lost.length > 0 ? (
        <ul
          className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted"
          aria-label="Where the missing points go"
        >
          {lost.map((part) => (
            <li key={part.level} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cn("size-2 rounded-[1px]", LOST_BG[part.level])} />
              {part.label}
              <span className="text-fg tabular-nums">
                {"\u2212"}
                {part.points}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The fixes worth the most, each a click from its issue. */
function NextFixes({ fixes }: { fixes: readonly ScoreFix[] }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <h3 className="text-xs font-medium text-fg-subtle">Raise it next</h3>
      <ol className="flex flex-col">
        {fixes.map((fix, index) => {
          const Icon = SIGNAL_KIND_ICONS[fix.kind];
          return (
            <li key={fix.peek}>
              <PeekLink
                peek={fix.peek}
                className="group -mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-ui outline-none transition-colors duration-120 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span className="w-3 shrink-0 text-xs text-fg-faint tabular-nums">{index + 1}</span>
                <Icon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate text-fg">{fix.title}</span>
                <span
                  className="shrink-0 font-medium text-success tabular-nums"
                  data-score-fix-points={fix.points}
                >
                  +{fix.points}&nbsp;pts
                </span>
                <ChevronRight
                  aria-hidden
                  className="size-3.5 shrink-0 text-fg-faint group-hover:text-fg-muted"
                />
              </PeekLink>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * What the score is made of (RC-226): each measured rate and the open issues,
 * as a number and a row of pixels, so the one number never hides its parts.
 */
function ScoreParts({ parts }: { parts: ReturnType<typeof scoreCopy>["parts"] }) {
  return (
    <dl
      className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-4 sm:grid-cols-3 lg:grid-cols-6"
      data-health-score-parts={parts.length}
    >
      {parts.map((part) => (
        <div key={part.key} className="flex min-w-0 flex-col gap-1">
          <dt className="truncate text-xs text-fg-subtle">{part.label}</dt>
          <dd className="flex items-center gap-2">
            <span className="text-sm font-semibold text-fg tabular-nums">{part.value}</span>
            <DotMeter
              value={part.value / 100}
              cells={10}
              tone="neutral"
              label={`${part.label}: ${part.value} of 100`}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}
