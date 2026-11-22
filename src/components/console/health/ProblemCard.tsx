"use client";

import { cn } from "@ratel/design-system/cn";
import { useLayoutEffect, useRef, useState } from "react";
import { ExamplesPanel } from "@/components/console/health/ExampleList";
import { FixLead } from "@/components/console/health/FixLead";
import { ProblemIcon } from "@/components/console/health/kinds";
import {
  groupAnchors,
  groupExamples,
  groupFigure,
  groupFixLead,
  groupTitle,
  groupTone,
  memberLabel,
  type ProblemGroup,
  preselectedMember,
  primaryOf,
  rowTools,
} from "@/components/console/health/problem-groups";
import {
  type DetailTab,
  type DetailTabState,
  DetailTabs,
  RowChevron,
  SignalDetails,
  useHash,
  useOpenSignal,
} from "@/components/console/health/SignalCard";
import { SlowByDesignButton } from "@/components/console/health/SlowByDesign";
import { ToolFilter } from "@/components/console/health/ToolFilter";
import { clampFigures } from "@/lib/readings/trace-signals/claims";
import {
  cardEnterDelayMs,
  signalTone,
  storyRowLimit,
  TONE_LABELS,
} from "@/lib/views/health/card-model";

/**
 * One kind of problem that several tools share, as one row: "Wrong tool keeps
 * showing up" once, with the tools it affects named beside the title, instead
 * of one row per tool.
 *
 * Open, a row of tool chips filters what is below it: "All" shows every
 * affected tool's examples (each labelled with its tool) and a short per-tool
 * summary; a tool's chip shows that tool's own examples and numbers, and the
 * "What to do" line turns to that tool. A `#signal-<id>` hash or the flow
 * map's "Open problem" for one of the tools opens this row with its chip
 * already chosen. Every member keeps its anchor.
 */

export interface ProblemCardProps {
  projectId: string;
  /** Two or more signals of one kind, worst first; a single signal is a `SignalCard`. */
  group: ProblemGroup;
  evidenceTurnsPerSignal: number;
  /** Position in the list, for the entrance stagger; null for rows that start hidden. */
  index: number | null;
  /** Kept in the markup (for its anchors) but not shown, until the list is expanded. */
  hidden?: boolean;
  /** Render open (tests, and any caller that knows the reader came for this row). */
  initiallyOpen?: boolean;
  /** Start on this tab (tests); otherwise each view opens on its own default. */
  initialTab?: DetailTab;
  /** Start with this member's chip picked (tests); otherwise "All" or the linked member. */
  initialToolId?: string;
}

/**
 * Open state for a group: open when the list's one open anchor is any of its
 * members'. Outside the list's provider it keeps its own, following the hash.
 */
function useGroupOpen(anchors: readonly string[], initiallyOpen: boolean) {
  const shared = useOpenSignal();
  const hash = useHash();
  const [local, setLocal] = useState<boolean | null>(initiallyOpen ? true : null);
  if (shared) {
    const open = shared.openAnchor !== null && anchors.includes(shared.openAnchor);
    return {
      open,
      animate: shared.toggled !== null && anchors.includes(shared.toggled),
      // Closing passes the anchor that is open, so the list's accordion reads
      // it as "the same row clicked again"; opening passes the row's own.
      toggle: () => shared.toggle(open && shared.openAnchor ? shared.openAnchor : anchors[0]!),
      openAnchor: shared.openAnchor,
      source: shared.source,
    };
  }
  const targeted = anchors.includes(hash.slice(1));
  const open = local ?? targeted;
  return {
    open,
    animate: true,
    toggle: () => setLocal(!open),
    openAnchor: targeted ? hash.slice(1) : null,
    source: "hash" as const,
  };
}

export function ProblemCard({
  projectId,
  group,
  evidenceTurnsPerSignal,
  index,
  hidden = false,
  initiallyOpen = false,
  initialTab,
  initialToolId,
}: ProblemCardProps) {
  const anchors = groupAnchors(group);
  const [anchor] = anchors;
  const bodyId = `${anchor}-body`;
  const fixId = `${anchor}-fix`;
  const articleRef = useRef<HTMLElement>(null);
  const clickTop = useRef<number | null>(null);
  const { open, animate, toggle, openAnchor, source } = useGroupOpen(anchors, initiallyOpen);

  // The chip in force: the reader's pick, as long as the page has not since
  // been sent to another member; else the member the page was sent to; else
  // "All" (null).
  const target = preselectedMember(group, openAnchor, source);
  const [picked, setPicked] = useState<{ id: string | null; forTarget: string | null } | null>(
    initialToolId ? { id: initialToolId, forTarget: target } : null,
  );
  const selectedId = picked && picked.forTarget === target ? picked.id : target;
  const selected = selectedId
    ? group.members.find((member) => member.id === selectedId)
    : undefined;
  // The card's tab, held here rather than in the view below it: picking a
  // tool (a chip, or a line under Numbers) swaps that view, and the reader
  // stays on the tab they were reading. Null until they pick one.
  const [tab, setTab] = useState<DetailTab | null>(initialTab ?? null);
  const tabState: DetailTabState = { tab, onTabChange: setTab };

  const onToggle = () => {
    clickTop.current = articleRef.current?.getBoundingClientRect().top ?? null;
    toggle();
  };

  // Keep the clicked row under the pointer while the row above it folds away.
  useLayoutEffect(() => {
    const before = clickTop.current;
    clickTop.current = null;
    const node = articleRef.current;
    if (before === null || !node) return;
    const moved = node.getBoundingClientRect().top - before;
    if (Math.abs(moved) > 1) window.scrollBy(0, moved);
  }, [open]);

  const tone = groupTone(group);
  const title = groupTitle(group);
  const tools = rowTools(group);
  const figure = groupFigure(group);
  const lead = groupFixLead(group, open ? (selected?.id ?? null) : null);

  return (
    <article
      ref={articleRef}
      id={anchor}
      data-signal={group.kind}
      data-problem-group={group.members.length}
      data-problem-workflow={group.workflow?.id}
      data-signal-open={open ? "true" : "false"}
      hidden={hidden || undefined}
      style={index === null ? undefined : { animationDelay: `${cardEnterDelayMs(index)}ms` }}
      className={cn(
        "group/row relative scroll-mt-24 rounded-xl transition-colors duration-200",
        index !== null && "card-enter",
        open
          ? "bg-forest-600/80 ring-1 ring-inset ring-forest-300/70"
          : "bg-forest-600/30 hover:bg-forest-600/60 has-[>div>button:focus-visible]:bg-forest-600/60",
      )}
    >
      {/* The other members' anchors, so `#signal-<id>` for any of them lands here. */}
      {anchors.slice(1).map((other) => (
        <span
          key={other}
          id={other}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-0 scroll-mt-24"
        />
      ))}
      <div className="relative grid cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-4 sm:gap-x-3.5 sm:px-4">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-describedby={fixId}
          aria-label={`${title}: ${tools.count ?? `${group.members.length} tools, ${tools.names.join(", ")}${tools.more > 0 ? ` and ${tools.more} more` : ""}`}. ${figure.display} ${figure.caption}. ${TONE_LABELS[tone]}.`}
          className="absolute inset-0 z-0 cursor-pointer rounded-xl focus-visible:rounded-xl! focus-visible:outline-offset-[-2px]!"
        />
        <ProblemIcon
          kind={group.kind}
          tone={tone}
          className="pointer-events-none relative col-[1/2] row-[1/2] mt-1"
        />
        <p className="pointer-events-none relative col-[2/3] row-[1/2] flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span className="text-[15px] font-medium leading-6 text-cream">{title}</span>
          {/* One line, never wrapping. On a narrow screen the names are cut
              with an ellipsis, but "and 22 more" always stays whole. */}
          <span
            className="flex min-w-0 max-w-full items-baseline whitespace-nowrap text-[13px] text-warm-muted"
            data-problem-tools="true"
          >
            {tools.count && <span data-subject-count="true">{tools.count}</span>}
            <span className="min-w-0 truncate">
              {tools.names.map((name, at) => (
                <span key={name}>
                  {at > 0 && ", "}
                  <span className="font-mono text-[12px] text-cream-dim">{name}</span>
                </span>
              ))}
            </span>
            {tools.more > 0 && (
              <span className="shrink-0 text-warm-muted">&nbsp;and {tools.more} more</span>
            )}
          </span>
        </p>
        <div className="pointer-events-none relative col-[3/4] row-[1/2] flex items-start gap-2.5 sm:gap-3.5">
          <div className="min-w-[4.5rem] text-right sm:min-w-24">
            <span
              data-signal-figure="true"
              className="block font-display text-xl font-semibold leading-6 tabular-nums text-cream sm:text-2xl sm:leading-7"
            >
              {figure.display}
            </span>
            {/* On a phone the longer caption wraps under the figure instead of
                widening the column and squeezing the title. */}
            <span className="mt-0.5 ml-auto block max-w-[6.5rem] text-[11px] leading-4 text-warm-muted sm:max-w-none">
              {figure.caption}
            </span>
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
          <div data-signal-details="true" className="px-3 pb-5 sm:pl-[2.875rem] sm:pr-4">
            {/* Collapsed, the row is its title and one figure; what to do waits here. */}
            <FixLead id={fixId} lead={lead} />
            <ToolFilter
              group={group}
              selectedId={selectedId}
              onSelect={(id) => setPicked({ id, forTarget: target })}
            />
            {selected && (
              <SlowByDesignButton projectId={projectId} signal={selected} className="mt-3 pb-0" />
            )}
            <div className="mt-4">
              {selected ? (
                <SignalDetails
                  key={selected.id}
                  projectId={projectId}
                  signal={selected}
                  evidenceTurnsPerSignal={evidenceTurnsPerSignal}
                  bare
                  tabState={tabState}
                />
              ) : (
                <GroupAll
                  projectId={projectId}
                  group={group}
                  evidenceTurnsPerSignal={evidenceTurnsPerSignal}
                  onSelect={(id) => setPicked({ id, forTarget: target })}
                  tabState={tabState}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

const TONE_TEXT = {
  coral: "text-coral",
  amber: "text-ctx-tools",
  muted: "text-warm-muted",
} as const;

/**
 * "All": every tool's examples in one list, newest first and each labelled
 * with its tool, and a short per-tool summary under Numbers where a tool opens
 * its own chip.
 */
function GroupAll({
  projectId,
  group,
  evidenceTurnsPerSignal,
  onSelect,
  tabState,
}: {
  projectId: string;
  group: ProblemGroup;
  evidenceTurnsPerSignal: number;
  onSelect: (id: string) => void;
  tabState: DetailTabState;
}) {
  const items = groupExamples(group, null, storyRowLimit(evidenceTurnsPerSignal));
  const locked = evidenceTurnsPerSignal <= 0;
  const hasStories = group.members.some(
    (m) => m.evidence.turns.length > 0 || m.evidence.totalTurns > 0,
  );
  const total = group.members.reduce((sum, m) => sum + m.evidence.totalTurns, 0);
  return (
    <DetailTabs
      hasStories={hasStories}
      startOnExamples={items.length > 0}
      exampleTotal={Math.max(total, items.length)}
      locked={locked}
      examples={
        <ExamplesPanel
          projectId={projectId}
          signal={primaryOf(group)}
          turns={[]}
          items={items}
          labelTools
          locked={locked}
        />
      }
      numbers={<GroupNumbers group={group} onSelect={onSelect} />}
      tabState={tabState}
    />
  );
}

/** One line per tool: its name, its claim, its figure and raw count; a line opens the tool's chip. */
function GroupNumbers({
  group,
  onSelect,
}: {
  group: ProblemGroup;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="max-w-2xl" data-group-numbers="true">
      <ul className="divide-y divide-forest-300/50 overflow-hidden rounded-lg bg-base-deep/50 ring-1 ring-forest-300/50">
        {group.members.map((member) => (
          <li key={member.id}>
            <button
              type="button"
              onClick={() => onSelect(member.id)}
              className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 px-3 py-2.5 text-left outline-none transition-colors hover:bg-forest/55 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-coral/60"
            >
              <span className="min-w-0">
                <span className="block font-mono text-[12px] text-cream">
                  {memberLabel(member)}
                </span>
                <span className="mt-0.5 block text-[12px] leading-5 text-warm-muted">
                  {clampFigures(member.claim)}
                </span>
              </span>
              <span className="text-right">
                <span
                  className={cn(
                    "block text-[15px] font-semibold tabular-nums",
                    TONE_TEXT[signalTone(member.severity, false)],
                  )}
                >
                  {clampFigures(member.figure.display)}
                </span>
                <span className="block text-[11px] tabular-nums text-warm-muted">
                  {clampFigures(member.figure.raw)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-warm-muted">
        Pick a tool for its chart, likely range and notes.
      </p>
    </div>
  );
}
