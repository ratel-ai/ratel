import { cn } from "@ratel/design-system/cn";
import { Check } from "lucide-react";
import type { AnimationEvent, CSSProperties, ReactNode } from "react";
import {
  invokeGlyph,
  replayBeatAt,
  SLOW_STEP_MS,
  storyWindow,
} from "@/components/console/health/card-model";
import {
  EXAMPLE_KIND_MEANING,
  type FlagTone,
  flagText,
  nextPickIndex,
} from "@/components/console/health/example-copy";
import { StepGlyph } from "@/components/console/health/kinds";
import { OpenInTraces } from "@/components/console/health/OpenInTraces";
import { formatDuration, formatRank } from "@/lib/readings/trace-signals/claims";
import type {
  EvidenceTurn,
  SignalKind,
  StoryQuery,
  TurnStoryStep,
} from "@/lib/readings/trace-signals/view";

/**
 * How the flagged step is marked, by what it means (see `example-copy.ts`).
 * Only a fault, an agent-side failure, gets the coral ring; clutter is a
 * dashed amber "extra" marker, a note a plain amber one, neutral a muted one.
 */
const FLAG_STYLE: Record<FlagTone, { ring: string; glyph: string; label: string }> = {
  fault: {
    ring: "bg-[color-mix(in_srgb,var(--color-coral)_16%,var(--color-base-deep))] shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-coral)_12%,transparent)] ring-1 ring-coral/70",
    glyph: "text-coral",
    label: "text-coral",
  },
  clutter: {
    ring: "border border-dashed border-ctx-tools/80 bg-[color-mix(in_srgb,var(--color-ctx-tools)_10%,var(--color-base-deep))]",
    glyph: "text-ctx-tools",
    label: "text-ctx-tools",
  },
  note: {
    ring: "bg-[color-mix(in_srgb,var(--color-ctx-tools)_12%,var(--color-base-deep))] ring-1 ring-ctx-tools/70",
    glyph: "text-ctx-tools",
    label: "text-ctx-tools",
  },
  neutral: {
    ring: "bg-forest ring-1 ring-warm-muted/60",
    glyph: "text-cream-dim",
    label: "text-cream-dim",
  },
};

/**
 * One sampled turn told top to bottom, as a quiet timeline:
 *
 *   (magnifier) searched "move RC-40 to in review"
 *               (list) listed 10
 *   (wrench)    picked #7 update_task  (x) error
 *               Picked at #7
 *
 * Every step is muted except the one the signal is about, which gets the only
 * coral on the timeline and its flag label, so the eye lands on the moment it
 * went wrong. "Open in Traces" shows every call of the turn in Traces.
 *
 * With `replay`, the timeline plays itself once when it mounts: each step
 * settles in `REPLAY_BEAT_MS` after the one before it, and the flagged step's
 * coral ring and label land last. Reduced motion shows it whole at once.
 */

/** Longest query the story prints before it trims; the full text lives in the trace. */
const QUERY_PREVIEW_CHARS = 90;

/** A duration inside a flag label, e.g. "Took 14.2 s" or "Took 850 ms". */
const FLAG_TIME = /\d\s?(?:ms|s|min|h)\b/;

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** "Sep 27", in UTC so the server and the browser print the same day. */
export function storyDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : DAY_FORMAT.format(date);
}

/** "14:02", in UTC like the day, so two turns on one day can be told apart. */
export function storyTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : TIME_FORMAT.format(date);
}

/**
 * The replay is CSS keyframes with a delay per beat, so it starts the moment
 * the timeline mounts, needs no timers (which a background tab throttles),
 * never restarts on a re-render, and is skipped for reduced motion by the
 * `motion-safe:` variant. `both` holds each beat at its first frame until its
 * delay is up. The rules ship with the component and React hoists them once.
 */
const REPLAY_KEYFRAMES =
  "@keyframes health-beat-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}" +
  "@keyframes health-flag-land{from{opacity:0;transform:scale(.5)}to{opacity:1;transform:none}}";

/** A beat settling in: a short rise and fade on the house ease-out curve. */
const BEAT_IN = "motion-safe:animate-[health-beat-in_260ms_cubic-bezier(0.22,1,0.36,1)_both]";

/** The flagged step's coral ring landing, with a little overshoot. */
const FLAG_LAND =
  "motion-safe:animate-[health-flag-land_320ms_cubic-bezier(0.34,1.56,0.64,1)_both]";

/** Class and delay for beat `index` of a replay; nothing when not replaying. */
function beat(
  replay: boolean,
  index: number,
  motion: string = BEAT_IN,
): { className?: string; style?: CSSProperties } {
  return replay ? { className: motion, style: { animationDelay: `${replayBeatAt(index)}ms` } } : {};
}

export interface TurnStoryProps {
  projectId: string;
  turn: EvidenceTurn;
  /** Show every step; otherwise a long turn is folded around its flagged step. */
  full?: boolean;
  /** Unfolds the timeline; without it the folded steps are only counted. */
  onShowAll?: () => void;
  /** Play the steps in one after another when this mounts; the flagged step's coral lands last. */
  replay?: boolean;
  /**
   * Called once every beat has landed, so the caller can drop `replay`: a
   * panel hidden and shown again would otherwise restart the animations.
   */
  onReplayEnd?: () => void;
  /** Invoked ids that are skills, drawn with a book instead of a wrench. */
  skillIds?: ReadonlySet<string>;
  /**
   * Inside an example row that already says the day: drop the day line and
   * put "Open in Traces" under the timeline, where the replay ends.
   */
  bare?: boolean;
  /**
   * The kind of problem the turn is an example of: decides how the flagged
   * step is marked and whether the pick after it gets a check. Without it the
   * flagged step reads as a fault, as before.
   */
  kind?: SignalKind;
}

type StoryItem =
  | { kind: "fold"; key: string; count: number; where: "earlier" | "more" }
  | { kind: "step"; key: string; step: TurnStoryStep; last: boolean };

export function TurnStory({
  projectId,
  turn,
  full = false,
  onShowAll,
  replay = false,
  onReplayEnd,
  skillIds,
  bare = false,
  kind,
}: TurnStoryProps) {
  const day = storyDay(turn.startedAt);
  const total = turn.steps.length;
  const meaning = kind ? EXAMPLE_KIND_MEANING[kind] : null;
  const tone: FlagTone = meaning?.flagTone ?? "fault";
  const checkAt = meaning?.checkNextPick
    ? nextPickIndex(
        turn.steps,
        turn.steps.findIndex((step) => step.flag !== undefined),
      )
    : -1;
  const fold = full
    ? { start: 0, end: total, hiddenBefore: 0, hiddenAfter: 0 }
    : storyWindow(turn.steps);
  const items: StoryItem[] = [
    ...(fold.hiddenBefore > 0
      ? [
          {
            kind: "fold" as const,
            key: "before",
            count: fold.hiddenBefore,
            where: "earlier" as const,
          },
        ]
      : []),
    ...turn.steps.slice(fold.start, fold.end).map((step, index) => ({
      kind: "step" as const,
      key: String(fold.start + index),
      step,
      last: fold.start + index === total - 1 && fold.hiddenAfter === 0,
    })),
    ...(fold.hiddenAfter > 0
      ? [{ kind: "fold" as const, key: "after", count: fold.hiddenAfter, where: "more" as const }]
      : []),
  ];
  // One beat per line, then one more for the flagged step's highlight.
  const flagBeat = items.length;
  // Every example is a turn the ledger kept, so it always has a page in
  // Traces; the trace waterfall itself is linked from there, per call, when
  // Traces holds one.
  const traceLink = <OpenInTraces projectId={projectId} turn={turn} />;
  const traceBeat = beat(replay, flagBeat);

  return (
    <div
      data-turn-story={turn.turnId}
      data-replay={replay ? "true" : undefined}
      onAnimationEnd={
        replay && onReplayEnd ? (event) => replayEnded(event, onReplayEnd) : undefined
      }
    >
      {replay && (
        <style href="health-turn-replay" precedence="default">
          {REPLAY_KEYFRAMES}
        </style>
      )}
      {!bare && (
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <p className="text-[12px] text-warm-muted">
            A turn on <time dateTime={turn.startedAt}>{day || "an unknown day"}</time>
          </p>
          {traceLink}
        </div>
      )}
      <ol aria-label="What happened in this turn">
        {items.map((item, index) =>
          item.kind === "fold" ? (
            <FoldedSteps
              key={item.key}
              count={item.count}
              where={item.where}
              onShowAll={onShowAll}
              last={item.where === "more"}
              motion={beat(replay, index)}
            />
          ) : (
            <StoryStep
              key={item.key}
              step={item.step}
              last={item.last}
              motion={beat(replay, index)}
              landing={beat(replay, flagBeat, FLAG_LAND)}
              labelMotion={beat(replay, flagBeat)}
              skillIds={skillIds}
              tone={tone}
              label={
                item.step.flag && kind
                  ? flagText(kind, item.step.flag.label)
                  : item.step.flag?.label
              }
              rightPick={Number(item.key) === checkAt}
            />
          ),
        )}
      </ol>
      {bare && (
        <div className={cn("mt-3", traceBeat.className)} style={traceBeat.style}>
          {traceLink}
        </div>
      )}
    </div>
  );
}

type Motion = ReturnType<typeof beat>;

/** The replay is over when no beat under the timeline is still waiting or playing. */
function replayEnded(event: AnimationEvent<HTMLDivElement>, onEnd: () => void): void {
  const pending = event.currentTarget
    .getAnimations({ subtree: true })
    // Keyframe beats only: a hover transition on a link is not part of the replay.
    .some((animation) => "animationName" in animation && animation.playState !== "finished");
  if (!pending) onEnd();
}

/** The rail between two steps, drawn under the glyph of the one above. */
const RAIL =
  "before:absolute before:bottom-1 before:left-[9.5px] before:top-6 before:w-px before:bg-forest-300";

/** A quiet stand-in for the steps a long turn folds away; a button when it can unfold. */
function FoldedSteps({
  count,
  where,
  onShowAll,
  last,
  motion,
}: {
  count: number;
  where: "earlier" | "more";
  onShowAll?: () => void;
  last: boolean;
  motion: Motion;
}) {
  const text = `${count} ${where} ${count === 1 ? "step" : "steps"}`;
  return (
    <li
      data-folded-steps={count}
      style={motion.style}
      className={cn(
        "relative pl-8 text-[12px] leading-5 text-warm-muted",
        !last && cn("pb-3", RAIL),
        motion.className,
      )}
    >
      <span aria-hidden className="absolute left-[6px] top-[9.5px] h-px w-2 bg-warm-muted/60" />
      {onShowAll ? (
        <button
          type="button"
          onClick={onShowAll}
          className="cursor-pointer rounded underline decoration-forest-300 underline-offset-4 outline-none transition-colors hover:text-cream focus-visible:ring-2 focus-visible:ring-coral/60"
        >
          {text}
        </button>
      ) : (
        text
      )}
    </li>
  );
}

function StoryStep({
  step,
  last,
  motion,
  landing,
  labelMotion,
  skillIds,
  tone,
  label,
  rightPick,
}: {
  step: TurnStoryStep;
  last: boolean;
  motion: Motion;
  /** The flagged step's marker's own beat: the replay's last. */
  landing: Motion;
  labelMotion: Motion;
  skillIds?: ReadonlySet<string>;
  /** How the flagged step is marked; only a fault is coral. */
  tone: FlagTone;
  /** The flag label as the reader sees it. */
  label: string | undefined;
  /** The agent's pick in an example where it got it right: a subtle check. */
  rightPick: boolean;
}) {
  const flagged = step.flag !== undefined;
  const glyph = step.kind === "search" ? "search" : invokeGlyph(step.toolId, skillIds);
  const style = FLAG_STYLE[tone];
  return (
    <li
      data-flagged={flagged ? "true" : undefined}
      data-flag-tone={flagged ? tone : undefined}
      data-right-pick={rightPick ? "true" : undefined}
      style={motion.style}
      className={cn(
        "relative pl-8 text-[13px] leading-5",
        !last && cn("pb-3.5", RAIL),
        flagged ? "text-cream" : "text-warm-muted",
        motion.className,
      )}
    >
      {/* Every step arrives on a muted node; the flagged one's coral ring lands
          over it as the last beat. */}
      <span
        aria-hidden
        className="absolute left-0 top-0 flex size-5 items-center justify-center rounded-full bg-forest/70 ring-1 ring-forest-300"
      >
        <StepGlyph glyph={glyph} />
      </span>
      {flagged && (
        <span
          aria-hidden
          data-flag-ring="true"
          style={landing.style}
          className={cn(
            "absolute left-0 top-0 flex size-5 items-center justify-center rounded-full",
            style.ring,
            landing.className,
          )}
        >
          <StepGlyph glyph={glyph} flagged tone={style.glyph} />
        </span>
      )}
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        {step.kind === "search" ? (
          <SearchStep step={step} hot={flagged} />
        ) : (
          <InvokeStep step={step} hot={flagged} />
        )}
        {rightPick && (
          <span
            className="inline-flex items-center gap-1 self-center text-[11px] text-green"
            data-right-pick-mark="true"
          >
            <Check className="size-3" strokeWidth={2.25} aria-hidden />
            <span className="sr-only">the right pick</span>
          </span>
        )}
      </span>
      {label && (
        <span
          style={labelMotion.style}
          className={cn("mt-0.5 block text-[12px] font-medium", style.label, labelMotion.className)}
        >
          {label}
        </span>
      )}
    </li>
  );
}

function SearchStep({
  step,
  hot,
}: {
  step: Extract<TurnStoryStep, { kind: "search" }>;
  hot: boolean;
}) {
  return (
    <>
      <span>searched</span>
      <StoryQueryText query={step.query} hot={hot} />
      <span className="inline-flex basis-full items-center gap-1 text-[12px] tabular-nums text-warm-muted">
        <StepGlyph glyph="listed" />
        listed {step.listed}
      </span>
    </>
  );
}

function InvokeStep({
  step,
  hot,
}: {
  step: Extract<TurnStoryStep, { kind: "invoke" }>;
  hot: boolean;
}) {
  // A flag label that already states a time ("Took 14.2 s") says it exactly,
  // so the rounded duration is not printed twice; any other step keeps it.
  const timeInLabel = step.flag !== undefined && FLAG_TIME.test(step.flag.label);
  const slow = !timeInLabel && step.tookMs !== null && step.tookMs >= SLOW_STEP_MS;
  return (
    <>
      {step.pickedRank !== null ? (
        <span>
          picked <span className="tabular-nums">{formatRank(step.pickedRank)}</span>
        </span>
      ) : (
        <span>ran</span>
      )}
      <span
        className={cn(
          "min-w-0 break-all font-mono text-[12px]",
          hot ? "text-cream" : "text-cream-dim",
        )}
      >
        {step.toolId}
      </span>
      {slow && step.tookMs !== null && (
        <Chip>
          <StepGlyph glyph="slow" />
          {formatDuration(step.tookMs)}
        </Chip>
      )}
      {step.outcome === "error" && (
        <Chip className={hot ? "text-coral" : "text-cream-dim"}>
          <StepGlyph glyph="error" flagged={hot} />
          error
        </Chip>
      )}
    </>
  );
}

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 self-center whitespace-nowrap tabular-nums text-warm-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

function StoryQueryText({ query, hot }: { query: StoryQuery; hot: boolean }) {
  if (query.state === "not_captured") {
    return <em className="text-warm-muted/80">query not captured</em>;
  }
  if (query.state === "expired") {
    return <em className="text-warm-muted/80">query expired</em>;
  }
  const text =
    query.text.length > QUERY_PREVIEW_CHARS
      ? `${query.text.slice(0, QUERY_PREVIEW_CHARS - 1).trimEnd()}…`
      : query.text;
  return (
    <span
      className={cn("min-w-0 break-words", hot ? "text-cream" : "text-cream-dim")}
      title={query.text}
    >
      &ldquo;{text}&rdquo;
    </span>
  );
}
