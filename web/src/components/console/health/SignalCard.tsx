"use client";

import { cn } from "@ratel/design-system/cn";
import { ChevronDown, LockKeyhole } from "lucide-react";
import Link from "next/link";
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  SIGNAL_OPEN_EVENT,
  signalAnchorFromHash,
  signalAnchorId,
} from "@/components/console/health/anchors";
import { EvidenceChart } from "@/components/console/health/EvidenceChart";
import { ExamplesPanel } from "@/components/console/health/ExampleList";
import { FixLead } from "@/components/console/health/FixLead";
import { ProblemIcon } from "@/components/console/health/kinds";
import { SlowByDesignButton } from "@/components/console/health/SlowByDesign";
import { useSharedSurface } from "@/components/console/health/surface";
import { storyDay } from "@/components/console/health/TurnStory";
import { HEALTH_TIERS, TierGlyph } from "@/components/console/health/tiers";
import {
  clampFigures,
  figureCaption,
  formatCount,
  formatSharePercent,
  signalsTitle,
} from "@/lib/readings/trace-signals/claims";
import type { SignalView, SubjectChip } from "@/lib/readings/trace-signals/view";
import {
  cardEnterDelayMs,
  nameSeparator,
  type OpenSource,
  openReducer,
  resolveOpen,
  signalCaveat,
  signalTone,
  splitFix,
  storyRowLimit,
  subjectNeedsList,
  subjectPlainText,
  subjectText,
  subjectTotal,
  TONE_LABELS,
} from "@/lib/views/health/card-model";
import { capabilityCatalogHref } from "@/lib/views/intents/hrefs";

/**
 * One problem, at two depths.
 *
 * Closed, it is a single calm row anyone can read: a severity dot, a short
 * title, the tool it is about, one big figure with a tiny unit, and the first
 * sentence of what to do. Nothing else competes for the eye.
 *
 * Open, it shows the details a savvy reader wants, behind two tabs: Examples
 * (the sampled turns as a compact list of one-line gists, one, five or all at
 * a time; each opens into a timeline that replays step by step) and Numbers
 * (the full claim with catalog links, the raw counts, the likely range, who
 * decided the figure, the chart and the caveat).
 *
 * The whole row toggles through one real button stretched under the content.
 * The body grows with the house `grid-rows-[0fr]` to `[1fr]` idiom and is
 * `inert` while closed, so nothing inside it can take focus or be read out
 * until it is visible.
 */

export interface SignalCardProps {
  projectId: string;
  signal: SignalView;
  /** Example turns this plan may show; 0 turns the examples into a one-line upsell. */
  evidenceTurnsPerSignal: number;
  /** Position in the list, for the entrance stagger; null for rows that start hidden. */
  index: number | null;
  /** Under "Too early to call": a muted dot and quieter type. */
  tooEarly?: boolean;
  /** Render open (tests, and any caller that knows the reader came for this card). */
  initiallyOpen?: boolean;
  /** Kept in the markup (for its anchor) but not shown, until the list is expanded. */
  hidden?: boolean;
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The current `location.hash`, or "" on the server. */
export function useHash(): string {
  return useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash,
    () => "",
  );
}

/* - One open at a time ------------------------------------------------------ */

export interface OpenSignalState {
  /** The one open card's anchor, or null when every card is closed. */
  openAnchor: string | null;
  source: OpenSource;
  /** The card the reader last toggled; the only one whose body animates. */
  toggled: string | null;
  toggle: (anchor: string) => void;
}

const OpenSignalContext = createContext<OpenSignalState | null>(null);

/** The list's open card, or null outside an {@link OpenSignalProvider}. */
export function useOpenSignal(): OpenSignalState | null {
  return useContext(OpenSignalContext);
}

/**
 * Holds the problem list's single open card. A click opens a card and closes
 * the rest (or closes the open one); a new `#signal-<id>` hash or an open
 * request from the flow map does the same for its target. The rules live in
 * `openReducer` (card-model), so they are tested without a DOM.
 */
export function OpenSignalProvider({ children }: { children: ReactNode }) {
  const hashAnchor = signalAnchorFromHash(useHash());
  // null follows the hash; a click or an open request sets it.
  const [choice, dispatch] = useReducer(openReducer, null);

  useEffect(() => {
    const onHash = () => {
      if (signalAnchorFromHash(window.location.hash)) dispatch({ type: "hash" });
    };
    const onRequest = (event: Event) => {
      const anchor = (event as CustomEvent<unknown>).detail;
      if (typeof anchor === "string") dispatch({ type: "request", anchor });
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener(SIGNAL_OPEN_EVENT, onRequest);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(SIGNAL_OPEN_EVENT, onRequest);
    };
  }, []);

  const toggle = useCallback(
    (anchor: string) =>
      dispatch({ type: "click", anchor, hashAnchor: signalAnchorFromHash(window.location.hash) }),
    [],
  );
  const { openAnchor, source, toggled } = resolveOpen(choice, hashAnchor);
  const value = useMemo(
    () => ({ openAnchor, source, toggled, toggle }),
    [openAnchor, source, toggled, toggle],
  );
  return <OpenSignalContext.Provider value={value}>{children}</OpenSignalContext.Provider>;
}

/**
 * Open state for one card: from the list's provider when there is one (one
 * open at a time), else the card's own (a card rendered on its own, in tests).
 */
export function useCardOpen(anchor: string, initiallyOpen: boolean) {
  const shared = useContext(OpenSignalContext);
  const targeted = useHash() === `#${anchor}`;
  const [choice, setChoice] = useState<boolean | null>(initiallyOpen ? true : null);

  useEffect(() => {
    if (shared) return;
    const reopen = () => {
      if (window.location.hash === `#${anchor}`) setChoice(true);
    };
    window.addEventListener("hashchange", reopen);
    return () => window.removeEventListener("hashchange", reopen);
  }, [anchor, shared]);

  if (shared) {
    return {
      open: shared.openAnchor === anchor,
      // Closing because another card opened is instant, so the clicked row
      // does not ride up while the one above it folds away.
      animate: shared.toggled === anchor,
      toggle: () => shared.toggle(anchor),
    };
  }
  const open = choice ?? targeted;
  return { open, animate: true, toggle: () => setChoice(!open) };
}

export function SignalCard({
  projectId,
  signal,
  evidenceTurnsPerSignal,
  index,
  tooEarly = false,
  initiallyOpen = false,
  hidden = false,
}: SignalCardProps) {
  const anchor = signalAnchorId(signal.id);
  const bodyId = `${anchor}-body`;
  const fixId = `${anchor}-fix`;
  const articleRef = useRef<HTMLElement>(null);
  // The row's top when the reader clicked it; the layout effect below scrolls
  // by however far it moved (the open row above it closing), so the clicked
  // row stays under the pointer.
  const clickTop = useRef<number | null>(null);
  const { open, animate, toggle } = useCardOpen(anchor, initiallyOpen);

  const onToggle = () => {
    clickTop.current = articleRef.current?.getBoundingClientRect().top ?? null;
    toggle();
  };

  useLayoutEffect(() => {
    const before = clickTop.current;
    clickTop.current = null;
    const node = articleRef.current;
    if (before === null || !node) return;
    const moved = node.getBoundingClientRect().top - before;
    if (Math.abs(moved) > 1) window.scrollBy(0, moved);
  }, [open]);

  const tone = signalTone(signal.severity, tooEarly);
  const title = signalsTitle(signal.kind, [signal]);
  const subject = subjectText(signal);
  const subjectPlain = subjectPlainText(subject);
  const display = clampFigures(signal.figure.display);
  const caption = figureCaption(signal.kind, signal.figure);
  const { lead } = splitFix(clampFigures(signal.fix));

  return (
    <article
      ref={articleRef}
      id={anchor}
      data-signal={signal.kind}
      data-signal-open={open ? "true" : "false"}
      hidden={hidden || undefined}
      style={index === null ? undefined : { animationDelay: `${cardEnterDelayMs(index)}ms` }}
      className={cn(
        "group/row scroll-mt-24 rounded-xl transition-colors duration-200",
        index !== null && "card-enter",
        open
          ? "bg-forest-600/80 ring-1 ring-inset ring-forest-300/70"
          : "bg-forest-600/30 hover:bg-forest-600/60 has-[>div>button:focus-visible]:bg-forest-600/60",
      )}
    >
      <div className="relative grid cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-4 sm:gap-x-3.5 sm:px-4">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-describedby={fixId}
          aria-label={`${title}${subjectPlain ? `: ${subjectPlain}` : ""}. ${display} ${caption}. ${TONE_LABELS[tone]}.`}
          className="absolute inset-0 z-0 cursor-pointer rounded-xl focus-visible:rounded-xl! focus-visible:outline-offset-[-2px]!"
        />
        {/* 16px glyph centred on the title's 24px line. */}
        <ProblemIcon
          kind={signal.kind}
          tone={tone}
          className="pointer-events-none relative col-[1/2] row-[1/2] mt-1"
        />
        <p className="pointer-events-none relative col-[2/3] row-[1/2] flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span
            className={cn(
              "text-[15px] font-medium leading-6",
              tooEarly ? "text-cream-dim" : "text-cream",
            )}
          >
            {title}
          </span>
          {subject && <SubjectLine subject={subject} />}
        </p>
        <div className="pointer-events-none relative col-[3/4] row-[1/2] flex items-start gap-2.5 sm:gap-3.5">
          <div className="min-w-[4.5rem] text-right sm:min-w-24">
            <span
              data-signal-figure="true"
              className={cn(
                "block font-display text-xl font-semibold leading-6 tabular-nums sm:text-2xl sm:leading-7",
                tooEarly ? "text-cream-dim" : "text-cream",
              )}
            >
              {display}
            </span>
            <span className="mt-0.5 block text-[11px] leading-4 text-warm-muted">{caption}</span>
          </div>
          <RowChevron open={open} />
        </div>
      </div>

      <div
        className={cn(
          "grid",
          animate &&
            "transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div id={bodyId} className="min-h-0 min-w-0 overflow-hidden" inert={!open || undefined}>
          {/* Collapsed, the row is its title and one figure; what to do opens with the rest. */}
          <FixLead id={fixId} lead={lead} className="px-3 sm:pl-[2.875rem] sm:pr-4" />
          <SlowByDesignButton
            projectId={projectId}
            signal={signal}
            className="px-3 sm:pl-[2.875rem] sm:pr-4"
          />
          <SignalDetails
            projectId={projectId}
            signal={signal}
            evidenceTurnsPerSignal={evidenceTurnsPerSignal}
          />
        </div>
      </div>
    </article>
  );
}

/**
 * The affordance every row carries, always visible: a chevron in a small round
 * plate on the right, brighter on hover and focus, turned up when open.
 */
export function RowChevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      data-row-chevron="true"
      className={cn(
        "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors duration-200",
        open
          ? "bg-forest text-cream"
          : "bg-forest/70 text-cream-dim group-hover/row:bg-forest group-hover/row:text-cream",
      )}
    >
      <ChevronDown
        className={cn(
          "size-4 transition-transform duration-300 motion-reduce:transition-none",
          open && "rotate-180",
        )}
      />
    </span>
  );
}

export function SubjectLine({ subject }: { subject: NonNullable<ReturnType<typeof subjectText>> }) {
  if (subject.kind === "label") {
    return <span className="text-[13px] text-warm-muted">{subject.text}</span>;
  }
  // Many tools: just how many, on one line. The details list them.
  if (subject.kind === "count") {
    return (
      <span
        className="whitespace-nowrap text-[13px] text-warm-muted"
        data-subject-count={subject.count}
      >
        {subject.text}
      </span>
    );
  }
  return (
    // One line, like a grouped row: a name that does not fit ends in an
    // ellipsis, and the details name every tool in full.
    <span
      className="min-w-0 max-w-full truncate text-[13px] text-warm-muted"
      data-subject-names="true"
    >
      {subject.names.map((name, index) => (
        <span key={`${name}-${index}`}>
          {nameSeparator(index, subject.names.length, subject.joiner)}
          <span className="font-mono text-[12px] text-cream-dim">{name}</span>
        </span>
      ))}
    </span>
  );
}

/* - Details ----------------------------------------------------------------- */

export type DetailTab = "examples" | "numbers";

const TAB_LABELS: Record<DetailTab, string> = { examples: "Examples", numbers: "Numbers" };

/**
 * A tab a card holds on to across its tool filter. `null` until the reader
 * picks one, so each view opens on its own default until then.
 */
export interface DetailTabState {
  tab: DetailTab | null;
  onTabChange: (tab: DetailTab) => void;
}

/**
 * The tab to show: the reader's pick when this view has it, else the view's
 * own default (Examples when it has example turns to show, else Numbers).
 */
export function effectiveDetailTab(
  picked: DetailTab | null,
  tabs: readonly DetailTab[],
  startOnExamples: boolean,
): DetailTab {
  if (picked && tabs.includes(picked)) return picked;
  return startOnExamples && tabs.includes("examples") ? "examples" : "numbers";
}

/**
 * One signal's details: its examples and its numbers. `bare` drops the outer
 * padding, for a group that lays its tool filter above the tabs; `tabState`
 * lets that group keep the reader's tab when the filter swaps this view.
 */
export function SignalDetails({
  projectId,
  signal,
  evidenceTurnsPerSignal,
  bare = false,
  tabState,
}: {
  projectId: string;
  signal: SignalView;
  evidenceTurnsPerSignal: number;
  bare?: boolean;
  tabState?: DetailTabState;
}) {
  const turns = signal.evidence.turns.slice(0, storyRowLimit(evidenceTurnsPerSignal));
  // The plan cut has already emptied `turns` on free, so whether there is
  // anything to upsell is read from the total behind the signal.
  const hasStories = signal.evidence.turns.length > 0 || signal.evidence.totalTurns > 0;
  const locked = evidenceTurnsPerSignal <= 0;
  const tabs = (
    <DetailTabs
      hasStories={hasStories}
      startOnExamples={turns.length > 0}
      exampleTotal={Math.max(signal.evidence.totalTurns, turns.length)}
      locked={locked}
      examples={
        <ExamplesPanel projectId={projectId} signal={signal} turns={turns} locked={locked} />
      }
      numbers={<NumbersPanel projectId={projectId} signal={signal} />}
      tabState={tabState}
    />
  );
  if (bare) return tabs;
  return (
    <div data-signal-details="true" className="px-3 pb-5 sm:pl-[2.875rem] sm:pr-4">
      {tabs}
    </div>
  );
}

/**
 * The Examples and Numbers tabs, shared by a single signal's details and a
 * group's "All" view. Arrow keys, Home and End move between tabs. With
 * `tabState` the tab is the caller's (a group card keeps it across its tool
 * filter); without, it is this view's own.
 */
export function DetailTabs({
  hasStories,
  startOnExamples,
  exampleTotal,
  locked,
  examples,
  numbers,
  tabState,
}: {
  hasStories: boolean;
  startOnExamples: boolean;
  exampleTotal: number;
  locked: boolean;
  examples: ReactNode;
  numbers: ReactNode;
  tabState?: DetailTabState;
}) {
  const shared = useSharedSurface();
  const baseId = useId();
  const tabs: readonly DetailTab[] = hasStories ? ["examples", "numbers"] : ["numbers"];
  const [ownTab, setOwnTab] = useState<DetailTab | null>(null);
  const tab = effectiveDetailTab(tabState ? tabState.tab : ownTab, tabs, startOnExamples);
  const setTab = tabState ? tabState.onTabChange : setOwnTab;
  const tabRefs = useRef<Partial<Record<DetailTab, HTMLButtonElement | null>>>({});

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = tabs.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? tabs[(at + 1) % tabs.length]
        : event.key === "ArrowLeft"
          ? tabs[(at - 1 + tabs.length) % tabs.length]
          : event.key === "Home"
            ? tabs[0]
            : event.key === "End"
              ? tabs[tabs.length - 1]
              : null;
    if (!next) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      {tabs.length > 1 && (
        <div
          role="tablist"
          aria-label="Details"
          className="inline-flex rounded-lg bg-base-deep/70 p-0.5"
        >
          {tabs.map((key) => (
            <button
              key={key}
              ref={(node) => {
                tabRefs.current[key] = node;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${key}`}
              aria-selected={tab === key}
              aria-controls={`${baseId}-panel-${key}`}
              tabIndex={tab === key ? 0 : -1}
              onClick={() => setTab(key)}
              onKeyDown={onKeyDown}
              className={cn(
                "rounded-md px-3 py-1 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-coral/60",
                tab === key ? "bg-forest text-cream" : "text-warm-muted hover:text-cream",
              )}
            >
              {TAB_LABELS[key]}
              {key === "examples" && exampleTotal > 0 && (
                <span
                  className="ml-1.5 inline-flex items-center gap-0.5 tabular-nums text-warm-muted"
                  data-examples-tab-count={exampleTotal}
                >
                  {locked && (
                    <LockKeyhole className="size-2.5" aria-label={shared ? "private" : "on Plus"} />
                  )}
                  {formatCount(exampleTotal)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {hasStories && (
        <div
          role="tabpanel"
          id={`${baseId}-panel-examples`}
          aria-labelledby={`${baseId}-tab-examples`}
          hidden={tab !== "examples"}
          className="mt-4"
        >
          {examples}
        </div>
      )}
      <div
        role={tabs.length > 1 ? "tabpanel" : undefined}
        id={`${baseId}-panel-numbers`}
        aria-labelledby={tabs.length > 1 ? `${baseId}-tab-numbers` : undefined}
        hidden={tab !== "numbers"}
        className={tabs.length > 1 ? "mt-4" : "mt-1"}
      >
        {numbers}
      </div>
    </>
  );
}

/** A figure's likely range, in its own unit; only shares carry a range worth printing. */
function rangeText(signal: SignalView): string | null {
  if (!signal.interval || signal.figure.unit !== "share") return null;
  const { low, high } = signal.interval;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return `${formatSharePercent(low)} to ${formatSharePercent(high)}`;
}

export function NumbersPanel({ projectId, signal }: { projectId: string; signal: SignalView }) {
  const caveat = signalCaveat(signal);
  const range = rangeText(signal);
  const first = storyDay(signal.firstSeenAt);
  const last = storyDay(signal.lastSeenAt);
  const seen = first && last ? (first === last ? `on ${first}` : `${first} to ${last}`) : null;
  const tier = HEALTH_TIERS[signal.tier];

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="text-pretty text-sm leading-6 text-cream">
        <ClaimText projectId={projectId} signal={signal} />
      </p>
      {subjectNeedsList(signal) && <SubjectList projectId={projectId} signal={signal} />}
      <p className="text-[13px] leading-5 text-cream-dim" data-signal-cost="true">
        {clampFigures(signal.cost)}
      </p>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px] leading-5">
        <dt className="text-warm-muted">Measured</dt>
        <dd className="tabular-nums text-cream-dim">
          <span className="text-cream">{clampFigures(signal.figure.display)}</span>
          <span className="text-warm-muted"> · </span>
          <span data-signal-raw="true">{clampFigures(signal.figure.raw)}</span>
        </dd>
        {range && (
          <>
            <dt className="text-warm-muted">Likely between</dt>
            <dd className="tabular-nums text-cream-dim" data-signal-range="true">
              {range}
            </dd>
          </>
        )}
        <dt className="text-warm-muted">Decided by</dt>
        <dd className="flex items-center gap-1.5 text-cream-dim">
          <TierGlyph tier={signal.tier} className="-ml-0.5" />
          {tier.label}
        </dd>
        {seen && (
          <>
            <dt className="text-warm-muted">Found</dt>
            <dd className="text-cream-dim">{seen}</dd>
          </>
        )}
      </dl>

      {signal.evidence.chart && <EvidenceChart chart={signal.evidence.chart} />}

      {/* The row already says the first sentence; the whole fix is repeated
          here only when there is more to it than that. */}
      {splitFix(signal.fix).rest !== null && (
        <p data-signal-fix="true" className="text-[13px] leading-5 text-cream-dim">
          <span className="font-medium text-cream">What to do: </span>
          {clampFigures(signal.fix)}
        </p>
      )}

      {caveat && (
        <p data-signal-caveat="true" className="text-[12px] leading-5 text-warm-muted">
          <span className="text-cream-dim">Note: </span>
          {caveat}
        </p>
      )}
    </div>
  );
}

/** The claim with each subject swapped for a link that opens the catalog entry. */
function ClaimText({ projectId, signal }: { projectId: string; signal: SignalView }) {
  const chips = new Map(signal.subject.chips.map((chip) => [chip.id, chip]));
  return (
    <>
      {signal.claimSegments.map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index}>{clampFigures(segment.text)}</span>
        ) : (
          <SubjectChipLink
            key={index}
            projectId={projectId}
            chip={
              chips.get(segment.chipId) ?? {
                id: segment.chipId,
                label: segment.text,
                entryKind: "tool",
              }
            }
            text={segment.text}
          />
        ),
      )}
    </>
  );
}

/**
 * The tools a counted subject is about ("18 tools" on the row), as a tidy
 * grid of names, each opening its catalog entry. When a signal names fewer
 * than it counts (dead tools name at most 50), it says so.
 */
function SubjectList({ projectId, signal }: { projectId: string; signal: SignalView }) {
  const chips = signal.subject.chips.filter((chip) => chip.label.length > 0);
  const total = subjectTotal(signal);
  return (
    <div data-subject-list={total}>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-1">
        {chips.map((chip) => (
          <li key={chip.id} className="min-w-0">
            <SubjectChipLink projectId={projectId} chip={chip} text={chip.label} compact />
          </li>
        ))}
      </ul>
      {chips.length < total && (
        <p className="mt-2 text-[12px] leading-5 text-warm-muted" data-subject-list-cut="true">
          {chips.length} of {total} shown
        </p>
      )}
    </div>
  );
}

function SubjectChipLink({
  projectId,
  chip,
  text,
  compact = false,
}: {
  projectId: string;
  chip: SubjectChip;
  text: string;
  /** One name in a list: smaller, and cut with an ellipsis instead of wrapping. */
  compact?: boolean;
}) {
  const shared = useSharedSurface();
  const className = cn(
    "rounded font-mono underline underline-offset-4 outline-none transition-colors hover:decoration-cream-dim focus-visible:ring-2 focus-visible:ring-coral/60",
    // In a list, a quiet name that underlines on hover; a wall of underlines is noise.
    compact
      ? "block truncate text-[12px] leading-6 text-cream-dim decoration-transparent hover:text-cream"
      : "text-[13px] text-cream decoration-forest-300 [overflow-wrap:anywhere]",
  );
  // A shared page names the tool but opens nothing in the project.
  if (shared) {
    return (
      <span data-subject-chip={chip.id} className={cn(className, "no-underline")}>
        {text}
      </span>
    );
  }
  const href =
    chip.entryKind === "tool"
      ? capabilityCatalogHref(projectId, "tool", chip.id)
      : capabilityCatalogHref(projectId, "skill", chip.label, chip.id);
  return (
    <Link
      href={href}
      data-subject-chip={chip.id}
      title={`Open ${chip.label} in the catalog`}
      className={className}
    >
      {text}
    </Link>
  );
}
