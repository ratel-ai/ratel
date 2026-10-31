import { cn } from "@ratel/design-system/cn";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  Ban,
  BookOpen,
  Bot,
  CircleAlert,
  CircleQuestionMark,
  CircleX,
  Clock,
  Coins,
  EyeOff,
  Ghost,
  Hourglass,
  Inbox,
  Layers,
  Link2,
  List,
  ListPlus,
  type LucideIcon,
  Magnet,
  Puzzle,
  Repeat,
  Repeat1,
  RotateCcw,
  RouteOff,
  ScanSearch,
  Search,
  SearchSlash,
  Shuffle,
  Snail,
  Split,
  Timer,
  Undo2,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import {
  type SignalTone,
  type StepGlyphKind,
  TONE_LABELS,
} from "@/components/console/health/card-model";
import { signalTitle } from "@/lib/readings/trace-signals/claims";
import type { SignalKind } from "@/lib/readings/trace-signals/view";

export {
  CORAL_SEVERITY,
  type SignalTone,
  signalTone,
} from "@/components/console/health/card-model";

/**
 * One plain glyph per kind of problem, so a reader can tell a slow tool from a
 * magnet before reading a word. The vocabulary is shared with the journey map
 * and the example turns where they overlap: a timer is slow, a crossed circle
 * is failing, a magnifier is a search.
 */
export const SIGNAL_KIND_ICONS: { readonly [K in SignalKind]: LucideIcon } = {
  magnet: Magnet,
  buried_tool: ArrowDownToLine,
  sibling_confusion: ArrowLeftRight,
  first_try_miss: ScanSearch,
  error_loop: CircleX,
  latency_outlier: Timer,
  padding_share: ListPlus,
  dead_tool: Ghost,
  sequence_chain: Link2,
  no_follow_through: Undo2,
  abandoned_search: SearchSlash,
  unstable_intent: Split,
  repeat_invoke: Repeat,
  fragmented_intents: Puzzle,
  cooccurring_intents: Layers,
  tool_switch: Shuffle,
  empty_result: Inbox,
  unknown_tool: CircleQuestionMark,
  unused_tool: EyeOff,
  long_turn: Hourglass,
  blocked_action: Ban,
  identical_retry: Repeat1,
  wait_heavy: Clock,
  token_heavy: Coins,
  system_turn_failing: Bot,
  agent_failing: Users,
  workflow_failing: RouteOff,
  workflow_slow: Snail,
  workflow_fixed_chain: Workflow,
  // The self-correction noun's own mark (NOUN_ICONS), as on its page.
  self_correcting: RotateCcw,
};

/**
 * The glyph's colour carries severity: coral is worth fixing now, amber is
 * worth a look, and a problem still too early to call stays a faint outline.
 */
const TONE_ICON_CLASS: Record<SignalTone, string> = {
  coral: "text-coral",
  amber: "text-ctx-tools",
  muted: "text-warm-muted/60",
};

/** Glyph size and stroke, the same on every row and in the legend. */
const ICON_CLASS = "size-4 shrink-0";
const ICON_STROKE = 1.75;

/**
 * A problem row's kind glyph: bare, no plate or box, with an accessible name
 * that says the kind and the severity, so colour is never the only signal.
 */
export function ProblemIcon({
  kind,
  tone,
  className,
}: {
  kind: SignalKind;
  tone: SignalTone;
  className?: string;
}) {
  const Icon = SIGNAL_KIND_ICONS[kind];
  return (
    <Icon
      role="img"
      aria-label={`${signalTitle(kind)}, ${TONE_LABELS[tone].toLowerCase()}`}
      aria-hidden={false}
      data-problem-icon={kind}
      data-severity={tone}
      strokeWidth={ICON_STROKE}
      className={cn(ICON_CLASS, TONE_ICON_CLASS[tone], className)}
    />
  );
}

/** The legend's sample glyph in one severity colour; the words beside it carry the meaning. */
export function SeverityKey({ tone }: { tone: SignalTone }) {
  return (
    <CircleAlert
      aria-hidden
      data-severity-key={tone}
      strokeWidth={ICON_STROKE}
      className={cn("size-3.5 shrink-0", TONE_ICON_CLASS[tone])}
    />
  );
}

/**
 * One glyph per kind of step in an example turn, the same in the one-line gist
 * and the replayed timeline: a magnifier for a search, a list for what it
 * listed, a wrench for a tool call, a book for a skill, a clock for a slow call
 * and a crossed circle for an error.
 */
export const STEP_GLYPH_ICONS: Record<StepGlyphKind, LucideIcon> = {
  search: Search,
  listed: List,
  tool: Wrench,
  skill: BookOpen,
  error: CircleX,
  slow: Timer,
};

/** A step glyph at one size; muted unless it belongs to the flagged step. */
export function StepGlyph({
  glyph,
  flagged = false,
  tone,
  className,
}: {
  glyph: StepGlyphKind;
  flagged?: boolean;
  /** The flagged colour when it is not a fault: amber for clutter or a note. */
  tone?: string;
  className?: string;
}) {
  const Icon = STEP_GLYPH_ICONS[glyph];
  return (
    <Icon
      aria-hidden
      data-step-glyph={glyph}
      className={cn(
        "size-3 shrink-0",
        flagged ? (tone ?? "text-coral") : "text-warm-muted",
        className,
      )}
    />
  );
}
