"use client";

import { ChevronLeft, ChevronRight, ChevronsDownUp } from "lucide-react";
import {
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { JourneyDividers, JourneyLinks } from "@/components/console/health/JourneyLinks";
import { JourneyReadout } from "@/components/console/health/JourneyReadout";
import { JourneyStartRail } from "@/components/console/health/JourneyStartRail";
import { PREREQ_HINT } from "@/components/console/health/journey-copy";
import {
  JOURNEY_DRAW_FADE_MS,
  JourneyBase,
  JourneyDefs,
  JourneyHeader,
  JourneyLit,
  type JourneyMarkState,
  JourneyNodeMark,
} from "@/components/console/health/ToolJourneyParts";
import {
  JOURNEY_MAP_TOP,
  JOURNEY_RAIL_WIDTH,
  scrollStops,
  useJourneyScroll,
} from "@/components/console/health/use-journey-scroll";
import { useJourneyUnfold } from "@/components/console/health/use-journey-unfold";
import { usePrerequisiteFilter } from "@/components/console/health/use-prerequisite-filter";
import type {
  JourneyChain,
  JourneyPrerequisite,
} from "@/lib/readings/trace-signals/flow-journey-insights";
import type { FlowJourney } from "@/lib/readings/trace-signals/view";
import { isAcrossKey } from "@/lib/views/health/flow-journey-across";
import { journeyChainFocus } from "@/lib/views/health/flow-journey-focus";
import {
  JOURNEY_EXPAND_STEP,
  JOURNEY_VISIBLE_CALLS,
  type JourneyFocus,
  type JourneyLayout,
  type JourneyNode,
  journeyFocus,
  layoutJourney,
} from "@/lib/views/health/flow-journey-layout";

export interface ToolJourneyCanvasProps {
  journey: FlowJourney;
  /** The plain layout, computed on the server; expanding a column lays out again here. */
  layout: JourneyLayout;
  /** Node id (tool id, or `search`) to the DOM ids of its signal cards, first one first. */
  anchors: Readonly<Record<string, readonly string[]>>;
  /** Draw thin links too. `layout` must have been laid out with the same setting. */
  showAll?: boolean;
  /**
   * Show only what each tool needs first: the chips and links outside every
   * prerequisite's turns fade out, and what stays packs together with no
   * holes (`usePrerequisiteFilter`). Kept chips glide between the two maps.
   */
  filtered?: boolean;
  /** The prerequisites: what the filter keeps, and links drawn a little stronger in the full map. */
  prerequisites?: readonly JourneyPrerequisite[];
  /** A common chain being pointed at in its list: lit when nothing else is in focus. */
  chain?: JourneyChain | null;
  /** Tools the filtered map must name on their own chips: a focused workflow's steps. */
  unfoldTools?: readonly string[];
}

/**
 * The journey map's drawing and its interaction layer.
 *
 * - Hover (or keyboard focus) on a chip lights every turn that passed through
 *   it, start to finish; the readout under the map says it in sentences. A
 *   click keeps it lit and offers "Open problem" when a signal names the tool.
 * - "+N tools" opens in place: each press names three more tools of that
 *   column. The column grows (chips below it glide down, the new ones fade
 *   in) and its ribbons re-route with a short fade; nothing in another column
 *   moves. "Fewer" in the column's title folds it back.
 * - The map is drawn at its real size and scrolls sideways past the third
 *   call. The start column stays pinned as a slim rail, columns snap into
 *   place, fade in the first time they scroll into view, and a "4th call"
 *   affordance at the right edge (or the arrow keys) moves one column.
 * - Filtered to prerequisites, the map is packed and complete: none of that
 *   folding, unfolding or revealing on scroll happens.
 *
 * Under reduced motion every change simply happens.
 */

const STYLES = `
@media (prefers-reduced-motion: no-preference) {
  [data-journey-canvas] .flow-fade {
    animation: flow-fade ${JOURNEY_DRAW_FADE_MS}ms ease-out both;
    animation-delay: var(--flow-delay, 0ms);
  }
  [data-journey-canvas] .flow-dim {
    transition: opacity 160ms ease, fill-opacity 160ms ease;
  }
  [data-journey-canvas] [data-reveal] {
    transition: opacity 280ms ease, transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  [data-journey-canvas] [data-reveal="pending"] {
    opacity: 0;
    transform: translateX(18px);
  }
  [data-journey-canvas] [data-journey-stage] {
    transition: height 220ms cubic-bezier(0.2, 0.8, 0.2, 1), width 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
}
@keyframes flow-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
`;

const EXPAND_MS = 220;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function openSignal(ids: readonly string[] | undefined) {
  if (!ids || ids.length === 0) return;
  const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
  const present = ids.find((id) => document.getElementById(id));
  if (!present) {
    document.querySelector("[data-signals-locked]")?.scrollIntoView({ behavior, block: "center" });
    return;
  }
  if (window.location.hash === `#${present}`) {
    document.getElementById(present)?.scrollIntoView({ behavior, block: "start" });
    return;
  }
  window.location.hash = present;
}

function nodeState(node: JourneyNode, focus: JourneyFocus | null): JourneyMarkState {
  if (!focus) return "rest";
  if (focus.node === node.key) return "active";
  return (focus.nodes.get(node.key) ?? 0) > 0 ? "lit" : "dim";
}

/**
 * Chips that moved glide from where they were (FLIP), new ones fade in, and
 * the ribbons fade back in on their new routes.
 */
/** A column's identity across layouts that number columns differently. */
export function columnKey(column: Pick<JourneyLayout["columns"][number], "role" | "call">): string {
  return `${column.role}:${column.call}`;
}

function useGlide(stage: RefObject<HTMLDivElement | null>, layout: JourneyLayout) {
  const previous = useRef<Map<string, { x: number; y: number }> | null>(null);
  const heads = useRef<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const root = stage.current;
    const now = new Map(layout.nodes.map((node) => [node.key, { x: node.x, y: node.y }]));
    const before = previous.current;
    previous.current = now;
    const columnsNow = new Map(layout.columns.map((column) => [columnKey(column), column.x]));
    const columnsBefore = heads.current;
    heads.current = columnsNow;
    if (
      !root ||
      !before ||
      prefersReducedMotion() ||
      typeof Element.prototype.animate !== "function"
    )
      return;
    for (const el of root.querySelectorAll<SVGGElement>("[data-journey-head]")) {
      const key = el.getAttribute("data-journey-head") ?? "";
      const was = columnsBefore?.get(key);
      const at = columnsNow.get(key) ?? 0;
      if (was === undefined)
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: EXPAND_MS, easing: EASE });
      else if (Math.abs(was - at) > 0.5) {
        el.animate([{ transform: `translateX(${was - at}px)` }, { transform: "none" }], {
          duration: EXPAND_MS,
          easing: EASE,
        });
      }
    }
    for (const el of root.querySelectorAll<SVGGElement>("[data-journey-node]")) {
      const key = el.getAttribute("data-journey-node") ?? "";
      const was = before.get(key);
      const at = now.get(key) ?? { x: 0, y: 0 };
      if (was === undefined) {
        el.animate(
          [
            { opacity: 0, transform: "translateY(-6px)" },
            { opacity: 1, transform: "none" },
          ],
          {
            duration: EXPAND_MS,
            easing: EASE,
          },
        );
      } else if (Math.abs(was.y - at.y) > 0.5 || Math.abs(was.x - at.x) > 0.5) {
        el.animate(
          [{ transform: `translate(${was.x - at.x}px, ${was.y - at.y}px)` }, { transform: "none" }],
          {
            duration: EXPAND_MS,
            easing: EASE,
          },
        );
      }
    }
    // The ribbons are already on their new routes: they wait while the chips glide, then fade in under them.
    for (const layer of root.querySelectorAll(
      "[data-journey-base], [data-journey-lit-layer], [data-journey-links]",
    )) {
      layer.animate([{ opacity: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1 }], {
        duration: EXPAND_MS * 1.8,
        easing: "ease-out",
      });
    }
  }, [stage, layout]);
}

export function ToolJourneyCanvas({
  journey,
  layout: plain,
  anchors,
  showAll = false,
  filtered = false,
  prerequisites = [],
  chain = null,
  unfoldTools,
}: ToolJourneyCanvasProps) {
  const [hover, setHover] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<number, number>>({});
  const [depth, setDepth] = useState(JOURNEY_VISIBLE_CALLS);
  const reveal = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const full = useMemo(
    () =>
      Object.keys(expanded).length === 0 && depth === plain.depth
        ? plain
        : (layoutJourney(journey, { expanded, depth, showAll }) ?? plain),
    [plain, journey, expanded, depth, showAll],
  );
  const current = pin ?? hover;
  const filter = usePrerequisiteFilter(journey, filtered, prerequisites, current, unfoldTools);
  const packed = filter.phase === "compact" || filter.phase === "opening" ? filter.compact : null;
  const opening = filter.phase === "opening";
  const layout = packed ?? full;
  const whole = filter.phase === "full";
  const unfold = () => {
    if (!whole || layout.depth >= layout.calls) return;
    reveal.current = true;
    setDepth(layout.depth + 1);
  };
  const scroll = useJourneyScroll(scrollerRef, layout, unfold, { reveal: whole });
  useJourneyUnfold({
    scroller: scrollerRef,
    layout,
    view: scroll.view,
    setDepth,
    unfold,
    enabled: whole,
  });
  // Once an unfolded column is drawn, glide it into view.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!reveal.current || !el) return;
    reveal.current = false;
    // The new column lines up just right of the pinned rail; on a wide screen that
    // shows the fold after it too, on a phone the fold waits one more swipe away.
    const column = layout.columns[layout.depth];
    const stop = column ? Math.max(0, column.x - JOURNEY_RAIL_WIDTH - 8) : Number.POSITIVE_INFINITY;
    const left = Math.min(
      el.scrollWidth - el.clientWidth,
      Math.max(stop, column ? column.x + column.width + 8 - el.clientWidth : 0),
    );
    el.scrollTo({ left, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [layout.depth, layout.columns]);
  useGlide(stageRef, layout);

  const only = packed ? filter.view : null;
  const leaving = filter.phase === "leaving" ? filter.kept : null;
  const focus = useMemo(() => {
    if (only) return only.pointed ? only.focus : null;
    if (leaving) return leaving.focus;
    if (current && layout.nodes.some((n) => n.key === current))
      return journeyFocus(layout, current);
    return chain ? journeyChainFocus(layout, chain.tools) : null;
  }, [only, leaving, layout, current, chain]);
  const emphasis = useMemo(
    () => new Set(prerequisites.map((row) => `${row.first}>${row.tool}`)),
    [prerequisites],
  );
  const usualPairs = useMemo(
    () =>
      new Set(
        prerequisites
          .filter((row) => row.tier === "usual")
          .map((row) => `${row.first}>${row.tool}`),
      ),
    [prerequisites],
  );
  const byKey = useMemo(
    () => new Map(layout.nodes.map((node) => [node.key, node])),
    [layout.nodes],
  );
  const columnOf = useMemo(
    () => new Map(layout.nodes.map((node) => [node.key, node.column])),
    [layout.nodes],
  );

  const clearPin = useCallback(
    (restoreFocus: boolean) => {
      if (restoreFocus && pin) {
        rootRef.current
          ?.querySelector<SVGGElement>(`[data-journey-node="${CSS.escape(pin)}"]`)
          ?.focus();
      }
      setPin(null);
    },
    [pin],
  );

  useEffect(() => {
    if (!pin) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearPin(true);
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) clearPin(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [pin, clearPin]);

  const onActivate = (node: JourneyNode) => {
    if (node.kind === "later") {
      unfold();
      return;
    }
    if (node.kind === "other" && node.expandable > 0) {
      setExpanded((value) => ({
        ...value,
        [node.call]: (value[node.call] ?? 0) + JOURNEY_EXPAND_STEP,
      }));
      return;
    }
    setPin((value) => (value === node.key ? null : node.key));
  };
  const collapse = (call: number) => {
    setExpanded((value) =>
      Object.fromEntries(Object.entries(value).filter(([k]) => Number(k) !== call)),
    );
  };
  const onEnter = (node: JourneyNode) => setHover(node.key);
  const onLeave = () => setHover(null);

  const focused = current ? byKey.get(current) : undefined;
  const anchorIds = focused
    ? anchors[focused.kind === "search" ? "search" : focused.id]
    : undefined;
  const onOpen = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    openSignal(anchorIds);
  };
  const columns = layout.columns.map((column) => ({
    column,
    nodes: layout.nodes.filter((node) => node.column === column.index),
  }));

  return (
    <div data-journey-canvas="true" ref={rootRef}>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div className="relative overflow-hidden rounded-lg border border-line">
        <div
          ref={scrollerRef}
          tabIndex={0}
          role="region"
          aria-label={`How ${layout.turns.toLocaleString("en-US")} turns went, call by call. Use the arrow keys to move between calls.`}
          onKeyDown={scroll.onKeyDown}
          style={{ paddingTop: JOURNEY_MAP_TOP }}
          className="overflow-x-auto overscroll-x-contain pb-2 outline-none [scroll-snap-type:x_proximity] [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
        >
          <div
            ref={stageRef}
            data-journey-stage="true"
            className="relative overflow-hidden"
            style={{ width: layout.width, height: layout.height }}
          >
            {scrollStops(layout).map((stop) => (
              <div
                key={stop.label}
                aria-hidden
                className="absolute top-0 h-px w-px [scroll-snap-align:start]"
                style={{ left: stop.left }}
              />
            ))}
            <svg
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              className="absolute left-0 top-0 block select-none"
              onClick={() => pin && clearPin(false)}
            >
              <JourneyDefs />
              <g
                aria-hidden
                data-journey-base="true"
                data-journey-tier={only?.strong && !focus ? "usual" : undefined}
                style={{ opacity: leaving ? 0 : focus ? 0.16 : only?.strong ? 0.45 : 1 }}
                className="flow-dim"
              >
                <JourneyBase
                  ribbons={layout.ribbons}
                  columnOf={columnOf}
                  emphasis={packed ? undefined : emphasis}
                />
              </g>
              {layout.links && layout.links.length > 0 && (
                <JourneyLinks
                  links={layout.links}
                  focus={focus}
                  usual={usualPairs}
                  fading={opening}
                />
              )}
              {layout.dividers && layout.dividers.length > 0 && (
                <JourneyDividers dividers={layout.dividers} width={layout.width} fading={opening} />
              )}
              {focus && <JourneyLit ribbons={layout.ribbons} focus={focus} />}
              {only?.strong && !focus && (
                <JourneyLit ribbons={layout.ribbons} focus={only.strong} />
              )}
              {columns.map(({ column, nodes }) => (
                <g key={columnKey(column)} data-journey-col={column.index}>
                  <g data-journey-head={columnKey(column)}>
                    <JourneyHeader
                      column={column}
                      covered={
                        whole &&
                        scroll.scrolled &&
                        column.index > 0 &&
                        column.x < scroll.view.left + JOURNEY_RAIL_WIDTH + 24
                      }
                    />
                  </g>
                  {nodes.map((node) => (
                    <JourneyNodeMark
                      key={node.key}
                      node={node}
                      state={
                        only?.via.has(node.key) && focus?.node !== node.key
                          ? "dim"
                          : nodeState(node, focus)
                      }
                      lit={
                        focus
                          ? (focus.nodes.get(node.key) ?? 0)
                          : only
                            ? (filter.counts.get(node.key) ?? 0)
                            : null
                      }
                      hidden={
                        leaving
                          ? !leaving.focus.nodes.has(node.key)
                          : opening && isAcrossKey(node.key)
                      }
                      caption={only?.captions.get(node.key) ?? null}
                      label={only?.labels.get(node.key) ?? null}
                      opens={
                        (anchors[node.kind === "search" ? "search" : node.id]?.length ?? 0) > 0
                      }
                      pinned={pin === node.key}
                      onEnter={onEnter}
                      onLeave={onLeave}
                      onActivate={onActivate}
                    />
                  ))}
                </g>
              ))}
            </svg>
            {layout.columns
              .filter((column) => column.role === "call" && (layout.expanded[column.call] ?? 0) > 0)
              .map((column) => (
                <button
                  key={column.index}
                  type="button"
                  data-journey-collapse={column.call}
                  onClick={() => collapse(column.call)}
                  className="absolute inline-flex items-center gap-1 rounded-md border border-line bg-overlay px-1.5 text-xs text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-focus"
                  style={{ left: column.x + column.width - 58, top: 3 }}
                >
                  <ChevronsDownUp aria-hidden className="size-3" />
                  Fewer
                </button>
              ))}
          </div>
        </div>
        <JourneyStartRail
          layout={layout}
          visible={whole && scroll.scrolled}
          lit={focus?.nodes ?? null}
          activeKey={current}
          onEnter={onEnter}
          onLeave={onLeave}
          onActivate={onActivate}
        />
        {scroll.prev && whole && (
          <button
            type="button"
            data-journey-prev={scroll.prev.label}
            aria-label={`Back to ${scroll.prev.label}`}
            onClick={() => scroll.prev && scroll.goTo(scroll.prev.left)}
            style={{ left: 50, top: JOURNEY_MAP_TOP - 6 }}
            className="absolute z-20 inline-flex size-6 items-center justify-center rounded-md border border-line bg-overlay text-fg-muted shadow-overlay hover:text-fg focus-visible:outline focus-visible:outline-focus"
          >
            <ChevronLeft aria-hidden className="size-3.5" />
          </button>
        )}
        {scroll.next && (
          <div
            aria-hidden={false}
            className="pointer-events-none absolute inset-y-0 right-0 z-10 flex w-14 items-start justify-end pr-2 pt-2 sm:w-24"
            style={{ background: "linear-gradient(to right, transparent, var(--ds-app) 85%)" }}
          >
            <button
              type="button"
              data-journey-next={scroll.next.label}
              onClick={() => scroll.next && scroll.goTo(scroll.next.left)}
              className="pointer-events-auto inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-md border border-line bg-overlay py-0.5 pl-2 pr-1 text-xs text-fg-muted shadow-overlay hover:text-fg focus-visible:outline focus-visible:outline-focus"
            >
              {scroll.next.label}
              <ChevronRight aria-hidden className="size-3.5" />
            </button>
          </div>
        )}
      </div>
      {only ? (
        <div
          data-prereq-readout={only.sentences ? "focus" : "idle"}
          aria-live="polite"
          className="mt-2.5 min-h-10 text-xs leading-5"
        >
          {(only.sentences ?? [PREREQ_HINT]).map((line) => (
            <p key={line} className={only.sentences ? "text-fg-muted" : "text-fg-subtle"}>
              {line}
            </p>
          ))}
        </div>
      ) : (
        <JourneyReadout
          layout={layout}
          node={focused ?? null}
          focus={focus}
          pinned={pin !== null}
          anchor={anchorIds?.[0] ?? null}
          onOpen={onOpen}
          onClose={() => clearPin(true)}
        />
      )}
    </div>
  );
}
