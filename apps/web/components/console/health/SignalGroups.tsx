"use client";

import { cn } from "@ratel/design-system/cn";
import { ChevronDown } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  SIGNAL_OPEN_EVENT,
  signalAnchorFromHash,
  signalAnchorId,
} from "@/components/console/health/anchors";
import { ProblemCard } from "@/components/console/health/ProblemCard";
import {
  groupAnchors,
  groupByKind,
  groupKey,
  groupProblemsByArea,
  type ProblemGroup,
  primaryOf,
} from "@/components/console/health/problem-groups";
import { SignalCard, useHash, useOpenSignal } from "@/components/console/health/SignalCard";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import type { SignalView } from "@/lib/readings/trace-signals/view";
import { listScrollDelta, TOP_PROBLEMS } from "@/lib/views/health/card-model";
import type { ChainFolding } from "@/lib/views/health/workflows-view";

/**
 * The problem list's body: the rows at their two lengths, the button between
 * them, and the too-early rows folded away. Every row sits under one
 * `OpenSignalProvider` (from `SignalList`), so only one is ever open.
 */

/** The list section a row lives in; its top edge is what stays put on a switch. */
function listSection(node: HTMLElement | null): HTMLElement | null {
  return node?.closest<HTMLElement>("[data-signal-list]") ?? null;
}

/**
 * Expanded when the reader says so, or when the page is sent to one of the
 * rows it hides (a hash, or the flow map's "Open problem"). A new send clears
 * the reader's earlier "show fewer"; the row is scrolled to once it is visible,
 * since the browser could not while it was hidden. A reader's own click on a
 * row never scrolls.
 */
function useRevealTarget(anchorList: readonly string[]) {
  // Keyed by content, so a new array with the same rows does not resubscribe.
  const key = anchorList.join(" ");
  const hidden = useMemo(() => new Set(key ? key.split(" ") : []), [key]);
  const shared = useOpenSignal();
  const hashAnchor = signalAnchorFromHash(useHash());
  const target = shared ? shared.openAnchor : hashAnchor;
  const sentTo = shared ? shared.source !== "click" : true;
  const targetsHidden = sentTo && target !== null && hidden.has(target);
  const [choice, setChoice] = useState<boolean | null>(null);
  // A send latches the list open, so a later click on some other row (which
  // makes the source "click") does not fold it away again.
  if (targetsHidden && choice === null) setChoice(true);
  const expanded = choice ?? targetsHidden;
  // The target is scrolled to once per send, not every time the list reopens.
  const scrolledTo = useRef<string | null>(null);

  useEffect(() => {
    const onSend = (anchor: string | null) => {
      if (!anchor) return;
      scrolledTo.current = null;
      if (hidden.has(anchor)) setChoice(null);
    };
    const onHash = () => onSend(signalAnchorFromHash(window.location.hash));
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      onSend(typeof detail === "string" ? detail : null);
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener(SIGNAL_OPEN_EVENT, onRequest);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(SIGNAL_OPEN_EVENT, onRequest);
    };
  }, [hidden]);

  useEffect(() => {
    if (!expanded || !targetsHidden || !target || scrolledTo.current === target) return;
    scrolledTo.current = target;
    document.getElementById(target)?.scrollIntoView({ block: "start" });
  }, [expanded, target, targetsHidden]);

  return { expanded, setChoice };
}

export interface SignalGroupsProps {
  projectId: string;
  /** Signals above their floor, in any order; the list sorts them worst first. */
  signals: readonly SignalView[];
  evidenceTurnsPerSignal: number;
  /** Rows shown before "Show all". */
  limit?: number;
  /** Chains folded under the workflow they lie inside. */
  folding?: ChainFolding;
}

/**
 * The list body at its two lengths.
 *
 * Short (the default): the worst few as one flat list, so the first thing the
 * reader meets is "start here", not a taxonomy. The rest are in the markup,
 * hidden, so every `#signal-<id>` anchor exists for the flow map.
 *
 * Full ("Show all N problems"): every problem under its plain area heading
 * with a count, worst first inside each area, areas ordered by their worst.
 *
 * Switching keeps the list's top where it was (collapsing from deep in the
 * list brings it back under the header) before the frame paints, so the
 * reader never sees empty page. The entrance stagger only runs on first load;
 * rows that mount after a switch are there at once.
 */
export function SignalGroups({
  projectId,
  signals,
  evidenceTurnsPerSignal,
  limit = TOP_PROBLEMS,
  folding,
}: SignalGroupsProps) {
  const listId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  // One row per kind of problem; the short list is its worst few rows.
  const ordered = groupByKind(signals, folding);
  const hiddenAnchors = ordered.slice(limit).flatMap(groupAnchors);
  const { expanded, setChoice } = useRevealTarget(hiddenAnchors);
  const full = expanded && hiddenAnchors.length > 0;
  const [switched, setSwitched] = useState(false);
  const pending = useRef<{ beforeTop: number; collapsing: boolean } | null>(null);

  const onSwitch = () => {
    const section = listSection(bodyRef.current);
    pending.current = section
      ? { beforeTop: section.getBoundingClientRect().top, collapsing: full }
      : null;
    setSwitched(true);
    setChoice(!full);
  };

  useLayoutEffect(() => {
    const before = pending.current;
    pending.current = null;
    const section = listSection(bodyRef.current);
    if (!before || !section) return;
    const delta = listScrollDelta({ ...before, afterTop: section.getBoundingClientRect().top });
    if (delta !== 0) window.scrollBy(0, delta);
  }, [full]);

  // A kind with one signal keeps its familiar single row; several share one.
  const card = (group: ProblemGroup, index: number | null, hidden = false) =>
    group.members.length === 1 ? (
      <SignalCard
        key={groupKey(group)}
        projectId={projectId}
        signal={primaryOf(group)}
        index={switched ? null : index}
        hidden={hidden}
        evidenceTurnsPerSignal={evidenceTurnsPerSignal}
      />
    ) : (
      <ProblemCard
        key={groupKey(group)}
        projectId={projectId}
        group={group}
        index={switched ? null : index}
        hidden={hidden}
        evidenceTurnsPerSignal={evidenceTurnsPerSignal}
      />
    );

  return (
    <div ref={bodyRef} className="flex flex-col gap-1.5 [overflow-anchor:none]">
      <div id={listId} data-signal-view={full ? "grouped" : "top"}>
        {full ? (
          <div className="mt-1 flex flex-col gap-7">
            {groupProblemsByArea(ordered).map((area) => (
              <section
                key={area.key}
                aria-labelledby={`${listId}-${area.key}`}
                data-signal-group={area.key}
              >
                <GroupHeading
                  id={`${listId}-${area.key}`}
                  label={area.label}
                  count={area.groups.length}
                />
                <RowStack>{area.groups.map((group) => card(group, null))}</RowStack>
              </section>
            ))}
          </div>
        ) : (
          <RowStack>
            {ordered.map((group, index) =>
              index < limit ? card(group, index) : card(group, null, true),
            )}
          </RowStack>
        )}
      </div>
      {hiddenAnchors.length > 0 && (
        <div className="mt-1 border-t border-forest-300/60 pt-1.5">
          <FooterButton
            expanded={full}
            controls={listId}
            onClick={onSwitch}
            data-show-all="true"
            label={
              full
                ? `Show only the worst ${formatCount(limit)}`
                : `Show all ${formatCount(ordered.length)} problems`
            }
          />
        </div>
      )}
    </div>
  );
}

/** Rows as a stack of quiet surfaces with a hair of space between them. */
function RowStack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1.5">{children}</div>;
}

/** An area's name and count over its rows, with one hairline under it. */
function GroupHeading({ id, label, count }: { id: string; label: string; count: number }) {
  return (
    <h3
      id={id}
      className="mx-3 mb-2 flex items-baseline gap-2 border-b border-forest-300/60 pb-2 text-[13px] font-medium text-cream-dim sm:mx-4"
    >
      {label}
      <span className="tabular-nums text-warm-muted">{count}</span>
    </h3>
  );
}

/**
 * The list's own controls ("Show all", "Too early to call") as quiet full-width
 * rows, with the same chevron plate as a problem row, so the list ends on a
 * row rather than on a floating link.
 */
function FooterButton({
  expanded,
  controls,
  onClick,
  label,
  count,
  ...data
}: {
  expanded: boolean;
  controls: string;
  onClick: () => void;
  label: string;
  count?: number;
  "data-show-all"?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
      {...data}
      className="group/foot flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium text-cream-dim transition-colors hover:bg-forest-600/50 hover:text-cream focus-visible:rounded-xl! focus-visible:bg-forest-600/50 focus-visible:outline-offset-[-2px]! sm:px-4"
    >
      <span className="flex items-baseline gap-2">
        {label}
        {count !== undefined && <span className="tabular-nums text-warm-muted">{count}</span>}
      </span>
      <span
        aria-hidden
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-forest/70 transition-colors group-hover/foot:bg-forest"
      >
        <ChevronDown
          className={cn("size-4 transition-transform duration-300", expanded && "rotate-180")}
        />
      </span>
    </button>
  );
}

export interface TooEarlyRowsProps {
  projectId: string;
  /** Worst first. */
  signals: readonly SignalView[];
  evidenceTurnsPerSignal: number;
}

/** Problems seen but not yet sure, folded away under one quiet row. */
export function TooEarlyRows({ projectId, signals, evidenceTurnsPerSignal }: TooEarlyRowsProps) {
  const bodyId = useId();
  const { expanded, setChoice } = useRevealTarget(signals.map((s) => signalAnchorId(s.id)));
  return (
    <section data-too-early="true" className="mt-3 border-t border-forest-300/60 pt-1.5">
      <FooterButton
        expanded={expanded}
        controls={bodyId}
        onClick={() => setChoice(!expanded)}
        label="Too early to call"
        count={signals.length}
      />
      <div id={bodyId} hidden={!expanded || undefined} inert={!expanded || undefined}>
        <p className="mx-3 mb-2 text-[12px] leading-5 text-warm-muted sm:mx-4">
          Seen, but not on enough turns to be sure. They move up once they are.
        </p>
        <RowStack>
          {signals.map((signal) => (
            <SignalCard
              key={signal.id}
              projectId={projectId}
              signal={signal}
              index={null}
              evidenceTurnsPerSignal={evidenceTurnsPerSignal}
              tooEarly
            />
          ))}
        </RowStack>
      </div>
    </section>
  );
}
