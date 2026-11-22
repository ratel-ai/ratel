"use client";

import { cn } from "@ratel/design-system/cn";
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Eye,
  LockKeyhole,
  type LucideIcon,
  OctagonAlert,
  SearchX,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId, useMemo, useState } from "react";
import {
  type ExampleSubject,
  type ExampleVerdict,
  exampleSubject,
  exampleVerdict,
  exampleVerdictNote,
  exampleWhy,
  VERDICT_LABELS,
  whyNamesSubject,
} from "@/components/console/health/example-copy";
import { useExamplePageSize } from "@/components/console/health/example-page-size";
import { StepGlyph } from "@/components/console/health/kinds";
import { OpenInTraces } from "@/components/console/health/OpenInTraces";
import { Tooltip } from "@/components/console/health/primitives/tooltip";
import { memberLabel } from "@/components/console/health/problem-groups";
import { useSharedSurface } from "@/components/console/health/surface";
import { TurnStory } from "@/components/console/health/TurnStory";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import type { EvidenceTurn, SignalKind, SignalView } from "@/lib/readings/trace-signals/view";
import {
  type ExamplePageSize,
  effectivePageSize,
  examplePageSizeOptions,
  exampleSlice,
  UPGRADE_HREF,
} from "@/lib/views/health/card-model";

/**
 * One small glyph per verdict, before each example's sentence, that says whose
 * fault it was; its tooltip says it in words. Shapes differ per verdict, so
 * colour is never the only signal: a circled check when the agent got it
 * right, a warning triangle when it struggled, a coral octagon (a stop sign)
 * when the tool itself is the problem (not the wrench, which already marks the
 * tool steps right under it), a crossed-out search for a gap in the catalog,
 * an eye for something merely worth a look.
 */
const VERDICT_ICON: Record<ExampleVerdict, { Icon: LucideIcon; className: string }> = {
  agent_right: { Icon: CircleCheck, className: "text-green" },
  agent_struggled: { Icon: TriangleAlert, className: "text-ctx-tools" },
  tool_problem: { Icon: OctagonAlert, className: "text-coral" },
  catalog_gap: { Icon: SearchX, className: "text-cream-dim" },
  unclear: { Icon: Eye, className: "text-cream-dim" },
};

/**
 * The sampled turns as a compact list. A closed row says only what happened:
 * the verdict glyph and one sentence. Opening it shows the full timeline,
 * which replays itself step by step. The list is paged, one, five or twenty
 * at a time; the choice is remembered.
 */
/** An example and the signal it is evidence for; a group's list mixes several signals. */
export interface ExampleItem {
  signal: SignalView;
  turn: EvidenceTurn;
}

/** The skills a signal names, drawn with a book instead of a wrench. */
function skillIdsOf(signal: SignalView): ReadonlySet<string> {
  return new Set(
    signal.subject.chips
      .filter((chip) => chip.entryKind === "skill")
      .flatMap((chip) => [chip.id, chip.label]),
  );
}

export function ExamplesPanel({
  projectId,
  signal,
  turns,
  locked,
  items,
  labelTools = false,
}: {
  projectId: string;
  /** The signal the panel is about; a group passes its worst member. */
  signal: SignalView;
  turns: SignalView["evidence"]["turns"];
  locked: boolean;
  /** Examples from several signals (a group's "All"); overrides `turns`. */
  items?: readonly ExampleItem[];
  /** Name each example's tool above its sentence, for a list that mixes tools. */
  labelTools?: boolean;
}) {
  const [storedSize, setStoredSize] = useExamplePageSize();
  const [page, setPage] = useState(0);
  const list = useMemo<readonly ExampleItem[]>(
    () => items ?? turns.map((turn) => ({ signal, turn })),
    [items, turns, signal],
  );
  const sources = [...new Set(list.map((item) => item.signal))];
  const total = Math.max(
    (sources.length > 0 ? sources : [signal]).reduce(
      (sum, source) => sum + source.evidence.totalTurns,
      0,
    ),
    list.length,
  );
  const turnsShown = list.length;

  if (locked) return <LockedExamples total={total} />;
  if (turnsShown === 0) {
    return <p className="text-[13px] text-warm-muted">No example turns were kept for this one.</p>;
  }

  const size = effectivePageSize(storedSize, turnsShown);
  const slice = exampleSlice(page, size, turnsShown);
  const options = examplePageSizeOptions(turnsShown);
  const onSize = (next: ExamplePageSize) => {
    // Keep the first example on screen in view when the page size changes.
    setPage(Math.floor(slice.start / next));
    setStoredSize(next);
  };

  return (
    <div className="max-w-2xl" data-example-list="true">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-[12px] leading-5 text-warm-muted" data-examples-total={total}>
          <span className="tabular-nums text-cream-dim">{formatCount(turnsShown)}</span> of{" "}
          <span className="tabular-nums">{formatCount(total)}</span>{" "}
          {total === 1 ? "turn" : "turns"}
          <span className="text-warm-muted/80"> · open one to replay it</span>
        </p>
        {options.length > 1 && <PageSizeControl options={options} value={size} onChange={onSize} />}
      </div>
      <ul className="mt-2.5 divide-y divide-forest-300/50 overflow-hidden rounded-lg bg-base-deep/50 ring-1 ring-forest-300/50">
        {list.slice(slice.start, slice.end).map((item) => (
          <ExampleRow
            key={`${item.signal.id}:${item.turn.turnId}`}
            projectId={projectId}
            turn={item.turn}
            skillIds={skillIdsOf(item.signal)}
            kind={item.signal.kind}
            subject={exampleSubject(item.signal)}
            toolLabel={labelTools ? memberLabel(item.signal) : null}
          />
        ))}
      </ul>
      {slice.pageCount > 1 && (
        <div className="mt-2 flex items-center justify-end gap-1" data-example-pager="true">
          <PagerButton
            label={size === 1 ? "Previous example" : "Previous examples"}
            disabled={!slice.hasPrev}
            onClick={() => setPage(slice.page - 1)}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </PagerButton>
          <span
            aria-live="polite"
            className="min-w-16 text-center text-[12px] tabular-nums text-cream-dim"
          >
            {slice.label}
          </span>
          <PagerButton
            label={size === 1 ? "Next example" : "Next examples"}
            disabled={!slice.hasNext}
            onClick={() => setPage(slice.page + 1)}
          >
            <ChevronRight className="size-4" aria-hidden />
          </PagerButton>
        </div>
      )}
    </div>
  );
}

function PageSizeControl({
  options,
  value,
  onChange,
}: {
  options: readonly ExamplePageSize[];
  value: ExamplePageSize;
  onChange: (size: ExamplePageSize) => void;
}) {
  return (
    <div
      className="inline-flex items-center gap-2 text-[12px] text-warm-muted"
      data-example-page-size={value}
    >
      <span aria-hidden>Show</span>
      <div
        role="group"
        aria-label="Examples shown at once"
        className="inline-flex rounded-md bg-base-deep/70 p-0.5"
      >
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === value}
            onClick={() => onChange(option)}
            className={cn(
              "min-w-8 cursor-pointer rounded px-2 py-0.5 font-medium tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-coral/60",
              option === value ? "bg-forest text-cream" : "text-warm-muted hover:text-cream",
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One example turn: a row that looks and acts like the button it is (hover
 * wash, chevron, pointer, focus ring, Enter and Space), opening into its
 * timeline. Every open replays the timeline once; closing keeps it mounted so
 * it can fold away smoothly.
 */
function ExampleRow({
  projectId,
  turn,
  skillIds,
  kind,
  subject,
  toolLabel = null,
}: {
  projectId: string;
  turn: EvidenceTurn;
  skillIds: ReadonlySet<string>;
  kind: SignalKind;
  subject: ExampleSubject;
  /** The tool (or pair) this example is about, in a list that mixes tools. */
  toolLabel?: string | null;
}) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  // Counts opens: the timeline mounts on the first and remounts (replays) on each.
  const [plays, setPlays] = useState(0);
  // The play in which the reader unfolded the whole turn; that play stops replaying.
  const [unfoldedIn, setUnfoldedIn] = useState<number | null>(null);
  // The play whose replay has finished; switching tabs must not run it again.
  const [playedIn, setPlayedIn] = useState<number | null>(null);
  const verdict = exampleVerdict(kind, turn);
  const why = exampleWhy(kind, turn, subject);
  // The sentence usually names the tool already; the label is only for those that don't.
  const label = toolLabel && !whyNamesSubject(why, subject) ? toolLabel : null;

  const toggle = () => {
    if (!open) setPlays((count) => count + 1);
    setOpen(!open);
  };

  return (
    <li
      data-example-turn={turn.turnId}
      data-example-open={open ? "true" : "false"}
      className="relative"
    >
      {/* The verdict icon sits over the row, where the sentence starts, but
          outside the row's button: it takes focus on its own to show its
          tooltip, and a focusable element cannot live inside a button. The
          offset is the row's padding. */}
      <VerdictIcon
        verdict={verdict}
        note={exampleVerdictNote(kind, verdict)}
        onClick={toggle}
        // Below the tool label when there is one, on the sentence's first line.
        className={cn("absolute left-3 z-10", label ? "top-8" : "top-3")}
      />
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
        className={cn(
          "group grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2.5 text-left outline-none transition-colors duration-150",
          "hover:bg-forest/55 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-coral/60",
          open && "bg-forest/40",
        )}
      >
        {/* Only what happened: whose fault it was and one sentence. The steps
            and the time are in the timeline the row opens into. The right
            padding keeps the sentence clear of "Open in Traces" laid over it. */}
        <span className="flex min-w-0 flex-col gap-1 pr-16 sm:pr-28">
          {label && (
            <span
              className="-mb-1 block truncate font-mono text-[11px] leading-5 text-warm-muted"
              data-example-tool={label}
            >
              {label}
            </span>
          )}
          {/* The first line is indented for the verdict icon laid over it, so
              a long sentence wraps back to the left edge under the icon. */}
          <span className="min-w-0 indent-[21px] text-[13px] leading-5 text-cream">
            <span data-example-why="true">{why}</span>
          </span>
        </span>
        <span
          aria-hidden
          className={cn(
            "mt-px inline-flex size-[1.125rem] items-center justify-center rounded text-warm-muted ring-1 ring-forest-300/80 transition-[color,background-color,transform] duration-200",
            "group-hover:bg-forest group-hover:text-cream",
            open && "rotate-90 bg-forest text-cream",
          )}
        >
          <ChevronRight className="size-3" />
        </span>
      </button>
      {/* A link, so it sits beside the row's button rather than inside it,
          like the verdict icon: to the left of the chevron, on the first line. */}
      <OpenInTraces
        projectId={projectId}
        turn={turn}
        compact
        className="absolute right-[2.625rem] top-2.5 z-10 leading-5"
      />
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div id={bodyId} className="min-h-0 min-w-0 overflow-hidden" inert={!open || undefined}>
          {plays > 0 && (
            <div className="px-3 pb-4 pt-2 sm:pl-[2.0625rem]">
              <TurnStory
                key={plays}
                projectId={projectId}
                turn={turn}
                bare
                replay={unfoldedIn !== plays && playedIn !== plays}
                onReplayEnd={() => setPlayedIn(plays)}
                full={unfoldedIn !== null}
                onShowAll={() => setUnfoldedIn(plays)}
                skillIds={skillIds}
                kind={kind}
              />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * The verdict as one plain glyph, named for screen readers by its title. Its
 * tooltip (hover or keyboard focus, Esc closes) gives the title in bold and
 * one plain line on what it means for this kind of problem. A click opens the
 * example, as a click anywhere else on the row does.
 */
function VerdictIcon({
  verdict,
  note,
  onClick,
  className,
}: {
  verdict: ExampleVerdict;
  note: string;
  onClick: () => void;
  className?: string;
}) {
  const { Icon, className: tone } = VERDICT_ICON[verdict];
  const title = VERDICT_LABELS[verdict];
  return (
    <Tooltip
      side="top"
      content={
        <span className="block" data-verdict-tooltip={verdict}>
          <span className="block font-semibold text-cream">{title}</span>
          <span className="block">{note}</span>
        </span>
      }
    >
      <span
        role="img"
        aria-label={title}
        tabIndex={0}
        data-example-verdict={verdict}
        onClick={onClick}
        className={cn(
          "inline-flex size-[15px] cursor-help items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-coral/60",
          tone,
          className,
        )}
      >
        <Icon className="size-[15px]" strokeWidth={1.75} aria-hidden />
      </span>
    </Tooltip>
  );
}

/**
 * Free: the turns exist but are not shown. Says how many there are, hints at
 * the list with a few blank rows, and offers the one way to see them.
 */
function LockedExamples({ total }: { total: number }) {
  const shared = useSharedSurface();
  if (shared) return <PrivateExamples total={total} />;
  return (
    <div className="max-w-2xl" data-stories-locked="true">
      {total > 0 && (
        <p className="text-[12px] leading-5 text-warm-muted" data-examples-total={total}>
          <span className="tabular-nums text-cream-dim">{formatCount(total)}</span>{" "}
          {total === 1 ? "turn" : "turns"} behind this problem, each one you could replay step by
          step
        </p>
      )}
      <div className="relative mt-2.5 overflow-hidden rounded-lg bg-base-deep/50 ring-1 ring-forest-300/50">
        <ul aria-hidden className="divide-y divide-forest-300/40 opacity-60 blur-[1.5px]">
          {[0.62, 0.48, 0.7].map((width, index) => (
            <li key={index} className="flex items-center gap-2 px-3 py-3">
              <StepGlyph glyph={index === 1 ? "slow" : "error"} />
              <span
                className="h-2 rounded-full bg-forest-300/70"
                style={{ width: `${width * 80}%` }}
              />
            </li>
          ))}
        </ul>
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-base-deep/20 to-base-deep/70 p-3">
          <Link
            href={UPGRADE_HREF}
            className="inline-flex items-center gap-2 rounded-md bg-forest px-3 py-1.5 text-[13px] font-medium text-cream ring-1 ring-coral/40 outline-none transition-colors hover:bg-forest-600 hover:ring-coral/70 focus-visible:ring-2 focus-visible:ring-coral/70"
          >
            <LockKeyhole className="size-3.5 text-coral" aria-hidden />
            See example turns on Plus
          </Link>
        </div>
      </div>
    </div>
  );
}

/** On a shared page: how many runs stand behind the problem, and that they stay private. */
function PrivateExamples({ total }: { total: number }) {
  return (
    <p className="max-w-2xl text-[12px] leading-5 text-warm-muted" data-stories-private="true">
      {total > 0 && (
        <>
          <span className="tabular-nums text-cream-dim">{formatCount(total)}</span>{" "}
          {total === 1 ? "run" : "runs"} behind this problem.{" "}
        </>
      )}
      Example runs stay private to the project&apos;s team.
    </p>
  );
}

function PagerButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-md text-warm-muted outline-none transition-colors hover:bg-forest hover:text-cream focus-visible:ring-2 focus-visible:ring-coral/60 disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
