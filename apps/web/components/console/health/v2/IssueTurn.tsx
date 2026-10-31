"use client";

import { cn } from "@ratel/design-system/cn";
import { Tooltip } from "@ratel/design-system/tooltip";
import {
  Check,
  ChevronRight,
  CircleCheck,
  Eye,
  type LucideIcon,
  OctagonAlert,
  SearchX,
  SquareArrowOutUpRight,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { invokeGlyph, SLOW_STEP_MS, storyWindow } from "@/components/console/health/card-model";
import {
  EXAMPLE_KIND_MEANING,
  type ExampleSubject,
  type ExampleVerdict,
  exampleVerdict,
  exampleVerdictNote,
  exampleWhy,
  type FlagTone,
  flagText,
  nextPickIndex,
  VERDICT_LABELS,
  whyNamesSubject,
} from "@/components/console/health/example-copy";
import { STEP_GLYPH_ICONS } from "@/components/console/health/kinds";
import { storyDay, storyTime } from "@/components/console/health/TurnStory";
import { formatDuration, formatRank } from "@/lib/readings/trace-signals/claims";
import {
  type EvidenceTurn,
  exampleFocusEventId,
  type SignalKind,
  type StoryQuery,
  type TurnStoryStep,
  turnTracesHref,
} from "@/lib/readings/trace-signals/view";
import { productWords } from "@/lib/views/fixes/copy";

/**
 * One example turn of an issue, as a row that opens into its steps: whose
 * fault it was (an icon and a word), one plain sentence, when it ran and the
 * way to Traces. Open, a quiet timeline of every step, the one the issue is
 * about marked. Whatever a user typed (a captured search) appears only as
 * text, never in an attribute.
 */

const VERDICT_ICON: Readonly<Record<ExampleVerdict, { Icon: LucideIcon; tone: string }>> = {
  agent_right: { Icon: CircleCheck, tone: "text-success" },
  agent_struggled: { Icon: TriangleAlert, tone: "text-warning" },
  tool_problem: { Icon: OctagonAlert, tone: "text-danger" },
  catalog_gap: { Icon: SearchX, tone: "text-fg-muted" },
  unclear: { Icon: Eye, tone: "text-fg-muted" },
};

/** The marked step: red for a fault, amber for clutter or a note, gray otherwise. */
const FLAG_TONE: Readonly<Record<FlagTone, { ring: string; text: string }>> = {
  fault: { ring: "border-danger bg-danger-subtle text-danger", text: "text-danger" },
  clutter: {
    ring: "border-dashed border-warning bg-warning-subtle text-warning",
    text: "text-warning",
  },
  note: { ring: "border-warning bg-warning-subtle text-warning", text: "text-warning" },
  neutral: { ring: "border-line-active bg-selected text-fg-muted", text: "text-fg-muted" },
};

const QUERY_PREVIEW_CHARS = 120;

export function IssueTurn({
  projectId,
  turn,
  kind,
  subject,
  toolLabel = null,
  skillIds,
}: {
  projectId: string;
  turn: EvidenceTurn;
  kind: SignalKind;
  subject: ExampleSubject;
  /** The tool this example is about, in a list that mixes several. */
  toolLabel?: string | null;
  skillIds?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const verdict = exampleVerdict(kind, turn);
  const { Icon, tone } = VERDICT_ICON[verdict];
  const why = productWords(exampleWhy(kind, turn, subject));
  // The sentence usually names its tool already; the label is only for the ones that don't.
  const label = toolLabel && !whyNamesSubject(why, subject) ? toolLabel : null;
  const bodyId = `turn-${turn.turnId}`;
  return (
    <li className="border-b border-line last:border-b-0" data-issue-example={turn.turnId}>
      <div className="flex items-start gap-2 py-2">
        <Tooltip content={exampleVerdictNote(kind, verdict)}>
          <span
            tabIndex={0}
            className="mt-0.5 inline-flex shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
            data-example-verdict={verdict}
          >
            <Icon aria-hidden strokeWidth={1.5} className={cn("size-4", tone)} />
            <span className="sr-only">{VERDICT_LABELS[verdict]}</span>
          </span>
        </Tooltip>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className="group flex min-w-0 flex-1 items-start gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {label ? (
              <span className="truncate font-mono text-xs text-fg-subtle">{label}</span>
            ) : null}
            <span className="text-ui text-fg group-hover:underline">{why}</span>
            <span className="text-xs text-fg-subtle tabular-nums">
              <time dateTime={turn.startedAt}>
                {storyDay(turn.startedAt)}, {storyTime(turn.startedAt)}
              </time>
              {" · "}
              {turn.steps.length} {turn.steps.length === 1 ? "step" : "steps"}
            </span>
          </span>
          <ChevronRight
            aria-hidden
            className={cn(
              "mt-0.5 size-4 shrink-0 text-fg-subtle transition-transform duration-160 motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        </button>
        <Link
          href={turnTracesHref(projectId, turn.turnId, exampleFocusEventId(turn))}
          className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-sm text-xs text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          <SquareArrowOutUpRight aria-hidden className="size-3.5" />
          <span className="max-sm:sr-only">Open in Traces</span>
          <span className="sm:hidden">Traces</span>
        </Link>
      </div>
      <div id={bodyId} hidden={!open}>
        {open ? <TurnSteps turn={turn} kind={kind} skillIds={skillIds} /> : null}
      </div>
    </li>
  );
}

/** The turn's steps top to bottom, a long turn folded around the marked one until unfolded. */
function TurnSteps({
  turn,
  kind,
  skillIds,
}: {
  turn: EvidenceTurn;
  kind: SignalKind;
  skillIds?: ReadonlySet<string>;
}) {
  const [full, setFull] = useState(false);
  const meaning = EXAMPLE_KIND_MEANING[kind];
  const flagged = turn.steps.findIndex((step) => step.flag !== undefined);
  const rightPick = meaning.checkNextPick ? nextPickIndex(turn.steps, flagged) : -1;
  const fold = full
    ? { start: 0, end: turn.steps.length, hiddenBefore: 0, hiddenAfter: 0 }
    : storyWindow(turn.steps);
  const unfold = (count: number, where: string) => (
    <li className="pl-8">
      <button
        type="button"
        onClick={() => setFull(true)}
        className="rounded-sm text-xs text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus"
      >
        {count} {where} {count === 1 ? "step" : "steps"}
      </button>
    </li>
  );
  return (
    <ol aria-label="What happened in this turn" className="flex flex-col gap-2.5 pb-3 pl-6">
      {fold.hiddenBefore > 0 ? unfold(fold.hiddenBefore, "earlier") : null}
      {turn.steps.slice(fold.start, fold.end).map((step, index) => (
        <Step
          key={fold.start + index}
          step={step}
          tone={meaning.flagTone}
          label={step.flag ? flagText(kind, step.flag.label) : null}
          rightPick={fold.start + index === rightPick}
          skillIds={skillIds}
        />
      ))}
      {fold.hiddenAfter > 0 ? unfold(fold.hiddenAfter, "more") : null}
    </ol>
  );
}

function Step({
  step,
  tone,
  label,
  rightPick,
  skillIds,
}: {
  step: TurnStoryStep;
  tone: FlagTone;
  label: string | null;
  rightPick: boolean;
  skillIds?: ReadonlySet<string>;
}) {
  const flagged = step.flag !== undefined;
  const Glyph =
    STEP_GLYPH_ICONS[step.kind === "search" ? "search" : invokeGlyph(step.toolId, skillIds)];
  return (
    <li className="flex items-start gap-2" data-flagged={flagged ? "true" : undefined}>
      <span
        aria-hidden
        className={cn(
          "mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full border",
          flagged ? FLAG_TONE[tone].ring : "border-line bg-raised text-fg-subtle",
        )}
      >
        <Glyph className="size-3" strokeWidth={1.5} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn(
            "flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-ui",
            flagged ? "text-fg" : "text-fg-muted",
          )}
        >
          {step.kind === "search" ? (
            <SearchStep step={step} />
          ) : (
            <CallStep step={step} saysFailed={label !== null && /fail/i.test(label)} />
          )}
          {rightPick ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check aria-hidden className="size-3" />
              the right pick
            </span>
          ) : null}
        </span>
        {label ? (
          <span className={cn("text-xs font-medium", FLAG_TONE[tone].text)}>{label}</span>
        ) : null}
      </span>
    </li>
  );
}

function SearchStep({ step }: { step: Extract<TurnStoryStep, { kind: "search" }> }) {
  return (
    <>
      <span>Searched</span>
      <Query query={step.query} />
      <span className="text-xs text-fg-subtle tabular-nums">listed {step.listed}</span>
    </>
  );
}

function CallStep({
  step,
  saysFailed,
}: {
  step: Extract<TurnStoryStep, { kind: "invoke" }>;
  saysFailed: boolean;
}) {
  const slow = step.tookMs !== null && step.tookMs >= SLOW_STEP_MS;
  return (
    <>
      <span>
        {step.pickedRank !== null ? (
          <>
            Picked <span className="tabular-nums">{formatRank(step.pickedRank)}</span>
          </>
        ) : (
          "Ran"
        )}
      </span>
      <span className="min-w-0 font-mono text-xs break-all text-fg">{step.toolId}</span>
      {slow && step.tookMs !== null ? (
        <span className="text-xs text-fg-subtle tabular-nums">{formatDuration(step.tookMs)}</span>
      ) : null}
      {step.outcome === "error" && !saysFailed ? (
        <span className="text-xs text-danger">Failed</span>
      ) : null}
    </>
  );
}

/** A captured search, in quotes; cut when long, the rest is in Traces. */
function Query({ query }: { query: StoryQuery }) {
  if (query.state === "not_captured") return <em className="text-fg-subtle">query not captured</em>;
  if (query.state === "expired") return <em className="text-fg-subtle">query no longer kept</em>;
  const text =
    query.text.length > QUERY_PREVIEW_CHARS
      ? `${query.text.slice(0, QUERY_PREVIEW_CHARS - 1).trimEnd()}…`
      : query.text;
  return <span className="min-w-0 break-words text-fg">&ldquo;{text}&rdquo;</span>;
}
