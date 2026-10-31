"use client";

import { cn } from "@ratel/design-system/cn";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { usePrefersReducedMotion } from "@ratel/design-system/use-prefers-reduced-motion";
import type { Selection } from "d3-selection";
import type { ZoomBehavior, ZoomTransform } from "d3-zoom";
import { usePathname } from "next/navigation";
import {
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type GroupNameSpot,
  groupNameAt,
  type MapLabel,
  nameBox,
  TOOL_LINE_HEIGHT,
  toolLabel,
} from "@/components/console/intent-map/labels";
import { IntentCard, MapLegend, MapReadout } from "@/components/console/intent-map/MapChrome";
import { MapLoader } from "@/components/console/intent-map/MapLoader";
import {
  BADGE_RADIUS,
  Group,
  GroupBase,
  GroupName,
  GroupOutline,
  Mark,
  type NodeState,
  ToolLines,
  WarningBadge,
} from "@/components/console/intent-map/MapMarks";
import { createTextMeasures, type TextMeasures } from "@/components/console/intent-map/measure";
import { captureClientException } from "@/lib/platform/track-client";
import { blobReach } from "@/lib/views/intents/map/map-blobs";
import {
  type Bounds,
  centreOn,
  constrainView,
  fitTransform,
  type LabelChoice,
  type LabelObstacle,
  lerpTransform,
  type Point,
  placeLabelChoices,
  restingLabelIds,
  type ViewTransform,
  zoomFloor,
} from "@/lib/views/intents/map/map-geometry";
import {
  computeMarkedLayout,
  type MapMarks,
  markOrder,
  type ToolMark,
} from "@/lib/views/intents/map/map-marks";
import type { MapLayout } from "@/lib/views/intents/map/map-membership";
import { type IntentMapModel, mapLayoutKey } from "@/lib/views/intents/map/map-model";

/**
 * The intent map (DESIGN.md, Brand and Data visualization): every intent a
 * softly wobbling blob on a faint dot grid, as large as it is busy, its name
 * inside it, faintly tinted with its main task's color, and inside it the
 * tools its asks used, as dots along its lower edge in their tasks' colors. A
 * tool several intents use has a mark in each, ringed as shared. Calm at
 * rest: no lines. Point at a tool and the intents it serves light, with a line
 * from it to each of its other marks; point at an intent and its tools light,
 * with a card listing them beside it. A problem is a warning mark on the
 * outline, never an amber edge.
 *
 * Pan by dragging; zoom with the buttons, a pinch, or ⌘/Ctrl and scroll (a
 * plain scroll still scrolls the page). Pan and zoom are bounded: the drawing
 * can never be dragged out of view, and zooming out stops a little past the
 * fitted view (`constrainView`, `zoomFloor`). Names are sized in map units, so they
 * shrink as the map zooms out and are hidden once too small to read; tool
 * names keep their size and appear as the map zooms in. The keyboard walks
 * each intent and then the tools inside it, with the arrow keys; Enter opens,
 * Esc clears.
 *
 * Reusable: it reads only the plain model and reports ids (an intent's, or a
 * tool's for any of its marks). Selection lives with the caller (the URL), so
 * the same node stays lit across views.
 */

export type IntentMapHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  /** Centre an intent or a tool (its busiest mark) and light it, e.g. from search. */
  flyTo: (id: string) => void;
};

/** Zoom range; the floor is raised to `zoomFloor` of the fitted view once it is known. */
const SCALE = { min: 0.2, max: 4 };
const FIT_SCALE = { min: 0.2, max: 1.35 };
/** From this zoom the busiest tools are named at rest; from the next, every tool. */
const RESTING_TOOL_LABELS_AT = 0.8;
const ALL_TOOL_LABELS_AT = 1.6;
const FLY_MS = 380;
/** Height of the strip along the bottom that the readout and legend sit in. */
const CHROME_STRIP = 40;
/** The view a layout assumes before the real one is known. */
const STAND_IN_VIEW = { width: 1100, height: 620 };
/** Below this much uncovered width (a phone, where a panel covers the page) the view is left alone. */
const MIN_UNCOVERED = 280;
/** Room around the drawing when it is fitted, for the names of tools at its edge (map units). */
const FIT_ROOM = 8;

type Placed = {
  key: string;
  atRealSize: boolean;
  layout: MapLayout;
  marks: MapMarks;
  measures: TextMeasures;
};

/** What lights with a node: an intent and its own marks, or a tool's marks and the intents they sit in. */
type Lit = { asks: Set<string>; marks: Set<string>; tool: string | null };

export function IntentMap({
  model,
  selectedId,
  onOpen,
  onClear,
  obscuredRight,
  ref,
  className,
}: {
  model: IntentMapModel;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onClear: () => void;
  /** Pixels at the window's right edge that the caller covers while a node is open (its panel). */
  obscuredRight?: () => number;
  ref?: Ref<IntentMapHandle>;
  className?: string;
}) {
  const pathname = usePathname();
  const reducedMotion = usePrefersReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<{
    behavior: ZoomBehavior<SVGSVGElement, unknown>;
    selection: Selection<SVGSVGElement, unknown, null, undefined>;
    identity: ZoomTransform;
  } | null>(null);
  const transformRef = useRef<ViewTransform>({ x: 0, y: 0, k: 1 });
  /** What pan and zoom are bounded by: the drawing's extent, the view, and the lowest zoom. */
  const limitsRef = useRef<{
    bounds: Bounds;
    view: { width: number; height: number };
    floor: number;
  } | null>(null);
  /** Whether the reader has moved the view; until then it stays fitted as the view resizes. */
  const touchedRef = useRef(false);
  const frameRef = useRef(0);
  /** Moves an opened node out from under the caller's panel (set below, once selection is known). */
  const keepClearRef = useRef<() => void>(() => {});
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  /** The last layout placed, kept up while the next one is computed; `key` is the model it was laid out for. */
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [failed, setFailed] = useState(false);
  const [transform, setTransform] = useState<ViewTransform>({ x: 0, y: 0, k: 1 });
  /** An intent or a mark under the pointer. */
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** An intent or a mark with keyboard focus. */
  const [keyboardId, setKeyboardId] = useState<string | null>(null);
  /** An intent or a tool found by search stays lit until the reader points at something else. */
  const [foundId, setFoundId] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);

  // Laid out again only when what it draws moves (ids, volumes, links), never
  // for a new copy of the same model: the drawing, and the reader's pan and
  // zoom, stay. A changed model keeps the last layout up until the next is ready.
  const layoutKey = useMemo(() => mapLayoutKey(model), [model]);
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  const layout = placed?.layout ?? null;
  const marks = placed?.marks ?? null;
  const measures = placed?.measures ?? null;
  const asksById = useMemo(() => new Map(model.asks.map((ask) => [ask.id, ask])), [model]);
  const capabilitiesById = useMemo(
    () => new Map(model.capabilities.map((capability) => [capability.id, capability])),
    [model],
  );
  /** Keyboard order: each intent, busiest first, then the tools inside it. */
  const order = useMemo(
    () => (marks ? markOrder(model, marks) : model.asks.map((ask) => ask.id)),
    [marks, model],
  );
  const toolCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of model.links) counts.set(link.ask, (counts.get(link.ask) ?? 0) + 1);
    return counts;
  }, [model]);

  // Measured at once on mount (a hidden tab or a streamed page may never run a
  // resize callback), then kept current.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = (width: number, height: number) =>
      setSize((current) =>
        current && current.width === width && current.height === height
          ? current
          : { width, height },
      );
    const rect = element.getBoundingClientRect();
    measure(rect.width, rect.height);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) measure(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Laid out per model, in a space the size of the view: a stand-in size until
  // the view has a real one, then once more at the real size.
  const sizeRef = useRef(size);
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);
  const real = size !== null && size.width > 0 && size.height > 0;
  useEffect(() => {
    const atRealSize = Boolean(
      sizeRef.current && sizeRef.current.width > 0 && sizeRef.current.height > 0,
    );
    const view = atRealSize ? sizeRef.current! : STAND_IN_VIEW;
    const current = modelRef.current;
    let cancelled = false;
    (async () => {
      const measures = await createTextMeasures();
      return { measures, ...computeMarkedLayout(current, view) };
    })().then(
      (next) => {
        if (!cancelled)
          setPlaced({
            key: layoutKey,
            atRealSize,
            layout: next.layout,
            marks: next.marks,
            measures: next.measures,
          });
      },
      (error: unknown) => {
        if (cancelled) return;
        captureClientException(error, { digest: null, pathname: pathname ?? "", boundary: "app" });
        setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [layoutKey, real, pathname]);

  const apply = useCallback((next: ViewTransform) => {
    const zoom = zoomRef.current;
    if (!zoom) return;
    zoom.behavior.transform(zoom.selection, zoom.identity.translate(next.x, next.y).scale(next.k));
  }, []);

  const animateTo = useCallback(
    (target: ViewTransform) => {
      cancelAnimationFrame(frameRef.current);
      if (reducedMotion) {
        apply(target);
        return;
      }
      const from = transformRef.current;
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / FLY_MS);
        apply(lerpTransform(from, target, t));
        if (t < 1) frameRef.current = requestAnimationFrame(step);
      };
      frameRef.current = requestAnimationFrame(step);
    },
    [apply, reducedMotion],
  );

  const drawingBounds = useMemo((): Bounds | null => {
    if (!layout) return null;
    const { minX, minY, maxX, maxY } = layout.bounds;
    return {
      minX: minX - FIT_ROOM,
      minY: minY - FIT_ROOM,
      maxX: maxX + FIT_ROOM,
      maxY: maxY + FIT_ROOM,
    };
  }, [layout]);
  const fitTarget = useCallback((): ViewTransform | null => {
    if (!drawingBounds || !size || size.width <= 0 || size.height <= 0) return null;
    // The bottom strip holds the readout and the legend; the drawing fits above it.
    return fitTransform(
      drawingBounds,
      size.width,
      Math.max(1, size.height - CHROME_STRIP),
      12,
      FIT_SCALE,
    );
  }, [drawingBounds, size]);
  const fitTargetRef = useRef(fitTarget);
  useEffect(() => {
    fitTargetRef.current = fitTarget;
  }, [fitTarget]);

  const zoomBy = useCallback(
    (factor: number) => {
      if (!size) return;
      touchedRef.current = true;
      const current = transformRef.current;
      const floor = limitsRef.current?.floor ?? SCALE.min;
      const k = Math.min(SCALE.max, Math.max(floor, current.k * factor));
      const cx = size.width / 2;
      const cy = size.height / 2;
      animateTo({
        k,
        x: cx - ((cx - current.x) * k) / current.k,
        y: cy - ((cy - current.y) * k) / current.k,
      });
    },
    [animateTo, size],
  );

  /** A tool's busiest mark: where the tool is shown when it is found or opened. */
  const primaryMark = useCallback(
    (tool: string): ToolMark | null => marks?.byCapability.get(tool)?.[0] ?? null,
    [marks],
  );

  /** Where a node sits: an intent's core, a mark, or a tool's busiest mark. */
  const positionOf = useCallback(
    (id: string): Point | null => {
      if (!layout) return null;
      const mark = marks?.byId.get(id) ?? primaryMark(id);
      return layout.groups.get(id) ?? (mark ? (layout.nodes.get(mark.id) ?? null) : null);
    },
    [layout, marks, primaryMark],
  );

  const flyTo = useCallback(
    (id: string) => {
      const point = positionOf(id);
      if (!point || !size) return;
      touchedRef.current = true;
      animateTo(centreOn(point, size.width, size.height, Math.max(transformRef.current.k, 1.3)));
      const index = order.indexOf(asksById.has(id) ? id : (primaryMark(id)?.id ?? id));
      if (index >= 0) setFocusIndex(index);
      setHoverId(null);
      setFoundId(id);
    },
    [animateTo, asksById, order, positionOf, primaryMark, size],
  );

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => zoomBy(1.4),
      zoomOut: () => zoomBy(1 / 1.4),
      fit: () => {
        const target = fitTarget();
        if (!target) return;
        touchedRef.current = false;
        animateTo(target);
      },
      flyTo,
    }),
    [animateTo, fitTarget, flyTo, zoomBy],
  );

  // Pan and zoom, wired once, when the drawing first appears; the first view
  // fits it whole. A later layout keeps the view: refitted only while the
  // reader has not moved it (the effect after this one).
  const drawn = layout !== null && size !== null;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !drawn) return;
    let disposed = false;
    Promise.all([import("d3-zoom"), import("d3-selection")]).then(
      ([d3Zoom, d3Selection]) => {
        if (disposed) return;
        const selection = d3Selection.select(svg);
        const behavior = d3Zoom
          .zoom<SVGSVGElement, unknown>()
          .scaleExtent([limitsRef.current?.floor ?? SCALE.min, SCALE.max])
          // Every drag, pinch and wheel stays in bounds: the drawing never leaves the view.
          .constrain((transform) => {
            const limits = limitsRef.current;
            if (!limits) return transform;
            const next = constrainView(
              { x: transform.x, y: transform.y, k: transform.k },
              limits.view,
              limits.bounds,
            );
            return next.x === transform.x && next.y === transform.y
              ? transform
              : d3Zoom.zoomIdentity.translate(next.x, next.y).scale(next.k);
          })
          .clickDistance(4)
          // A plain wheel scrolls the page; ⌘/Ctrl and a trackpad pinch zoom the map.
          .filter((event: Event) =>
            event.type === "wheel"
              ? (event as WheelEvent).ctrlKey || (event as WheelEvent).metaKey
              : !(event as MouseEvent).button,
          )
          .on("zoom", (event: { transform: ZoomTransform; sourceEvent: Event | null }) => {
            // A drag, pinch or wheel is the reader moving the view; a fit or a fly is not.
            if (event.sourceEvent) touchedRef.current = true;
            const next = { x: event.transform.x, y: event.transform.y, k: event.transform.k };
            transformRef.current = next;
            setTransform(next);
          });
        selection.call(behavior).on("dblclick.zoom", null);
        zoomRef.current = { behavior, selection, identity: d3Zoom.zoomIdentity };
        touchedRef.current = false;
        const target = fitTargetRef.current();
        if (target) apply(target);
        // A node opened from the URL is moved out from under its panel.
        keepClearRef.current();
      },
      (error: unknown) => {
        if (!disposed)
          captureClientException(error, {
            digest: null,
            pathname: pathname ?? "",
            boundary: "app",
          });
      },
    );
    return () => {
      disposed = true;
      cancelAnimationFrame(frameRef.current);
      zoomRef.current?.selection.on(".zoom", null);
      zoomRef.current = null;
    };
    // Wired once per mounted drawing; `fitTargetRef` reads the latest layout and size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn]);

  // The bounds follow the drawing and the view; the zoom floor follows the fitted view.
  useEffect(() => {
    const target = fitTarget();
    if (!drawingBounds || !size || !target) return;
    const floor = zoomFloor(target.k);
    limitsRef.current = {
      bounds: drawingBounds,
      view: { width: size.width, height: size.height },
      floor,
    };
    zoomRef.current?.behavior.scaleExtent([floor, SCALE.max]);
  }, [drawingBounds, fitTarget, size]);

  // Until the reader moves it, the view stays fitted as the canvas resizes.
  useEffect(() => {
    if (!zoomRef.current || touchedRef.current) return;
    const target = fitTarget();
    if (target) apply(target);
  }, [apply, fitTarget]);

  /** What lights with a node: an intent and its own marks; a tool (or any mark of it) and every mark of it, with the intents they sit in. */
  const neighbourhood = useCallback(
    (id: string | null): Lit => {
      const lit: Lit = { asks: new Set(), marks: new Set(), tool: null };
      if (!id || !marks) return lit;
      if (asksById.has(id)) {
        lit.asks.add(id);
        for (const mark of marks.byAsk.get(id) ?? []) lit.marks.add(mark.id);
        return lit;
      }
      const tool = marks.byId.get(id)?.capability ?? (capabilitiesById.has(id) ? id : null);
      if (!tool) return lit;
      lit.tool = tool;
      for (const mark of marks.byCapability.get(tool) ?? []) {
        lit.marks.add(mark.id);
        lit.asks.add(mark.ask);
      }
      return lit;
    },
    [asksById, capabilitiesById, marks],
  );

  const known = (id: string | null) =>
    id !== null && (asksById.has(id) || capabilitiesById.has(id)) ? id : null;
  const selected = known(selectedId);
  const activeId = hoverId ?? keyboardId ?? foundId ?? selected;
  const active = useMemo(() => neighbourhood(activeId), [activeId, neighbourhood]);
  const pinned = useMemo(
    () => (selected && selected !== activeId ? neighbourhood(selected) : null),
    [activeId, neighbourhood, selected],
  );
  const anyLit = active.asks.size > 0 || active.marks.size > 0;
  const askLit = (id: string) => active.asks.has(id) || Boolean(pinned?.asks.has(id));
  const markLit = (id: string) => active.marks.has(id) || Boolean(pinned?.marks.has(id));
  const askState = (id: string): NodeState =>
    selected === id
      ? "selected"
      : keyboardId === id
        ? "focused"
        : askLit(id)
          ? "lit"
          : anyLit
            ? "dim"
            : "rest";
  const markState = (mark: ToolMark): NodeState =>
    selected === mark.capability
      ? "selected"
      : keyboardId === mark.id
        ? "focused"
        : markLit(mark.id)
          ? "lit"
          : anyLit
            ? "dim"
            : "rest";

  /** The lit tool's lines: from the mark pointed at (or its busiest one) to each of its other marks. */
  const lines = useMemo(() => {
    if (!layout || !marks) return null;
    const tool = active.tool ?? pinned?.tool ?? null;
    if (!tool) return null;
    const pointed = [hoverId, keyboardId]
      .map((id) => (id ? marks.byId.get(id) : undefined))
      .find((mark) => mark?.capability === tool);
    const from = pointed ?? primaryMark(tool);
    if (!from) return null;
    const source = layout.nodes.get(from.id);
    const targets = (marks.byCapability.get(tool) ?? [])
      .filter((mark) => mark.id !== from.id)
      .flatMap((mark) => {
        const node = layout.nodes.get(mark.id);
        return node ? [node] : [];
      });
    return source && targets.length > 0
      ? { source, targets, tint: capabilitiesById.get(tool)?.tint ?? null, from: from.id }
      : null;
  }, [active.tool, capabilitiesById, hoverId, keyboardId, layout, marks, pinned, primaryMark]);

  // A node opened under the caller's panel slides into the part of the map
  // still in view, at the same zoom; one already clear of it stays put.
  const obscuredRef = useRef(obscuredRight);
  useEffect(() => {
    obscuredRef.current = obscuredRight;
  }, [obscuredRight]);
  const keepClear = useCallback(() => {
    const container = containerRef.current;
    const cover = obscuredRef.current;
    const point = selected ? positionOf(selected) : null;
    // Before pan and zoom are wired there is no view to move; the wiring calls again.
    if (!container || !cover || !point || !layout || !selected || !zoomRef.current) return;
    const visible = window.innerWidth - cover() - container.getBoundingClientRect().left;
    if (visible < MIN_UNCOVERED || visible >= container.clientWidth) return;
    const t = transformRef.current;
    const group = layout.groups.get(selected);
    const reach = ((group ? blobReach(group.blob) : 12) + 8) * t.k + 24;
    if (point.x * t.k + t.x + reach <= visible) return;
    touchedRef.current = true;
    animateTo({ k: t.k, x: visible / 2 - point.x * t.k, y: t.y });
  }, [animateTo, layout, positionOf, selected]);
  useEffect(() => {
    keepClearRef.current = keepClear;
    keepClear();
  }, [keepClear]);

  // One tab stop, always on a drawn node: the last one focused while it is
  // still drawn (clamped when the model shrinks), else the busiest intent.
  const drawnOrder = layout
    ? order.filter((id) => layout.groups.has(id) || layout.nodes.has(id))
    : [];
  const preferred = order[Math.min(focusIndex, Math.max(0, order.length - 1))];
  const tabStop =
    preferred !== undefined && drawnOrder.includes(preferred) ? preferred : (drawnOrder[0] ?? null);

  const focusNode = useCallback((id: string) => {
    svgRef.current?.querySelector<SVGGElement>(`[data-node="${CSS.escape(id)}"]`)?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const id = (event.target as Element).getAttribute?.("data-node");
    if (event.key === "Escape") {
      event.preventDefault();
      setHoverId(null);
      setFoundId(null);
      onClear();
      return;
    }
    if (!id) return;
    const index = order.indexOf(id);
    const move = (next: number) => {
      event.preventDefault();
      const clamped = Math.min(order.length - 1, Math.max(0, next));
      setFocusIndex(clamped);
      focusNode(order[clamped]!);
    };
    if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "j")
      move(index + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "k")
      move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(order.length - 1);
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      // A mark opens its tool.
      onOpen(marks?.byId.get(id)?.capability ?? id);
    }
  }

  function onNodeFocus(event: FocusEvent<SVGGElement>, id: string) {
    const index = order.indexOf(id);
    if (index >= 0) setFocusIndex(index);
    if (!event.currentTarget.matches(":focus-visible")) return;
    setKeyboardId(id);
    // Keep the focused node in view: a keyboard reader cannot drag the map to it.
    const point = positionOf(id);
    if (point && size) {
      const t = transformRef.current;
      const sx = point.x * t.k + t.x;
      const sy = point.y * t.k + t.y;
      if (sx < 48 || sy < 48 || sx > size.width - 48 || sy > size.height - 48)
        animateTo(centreOn(point, size.width, size.height, t.k));
    }
  }

  // Names in map units: refit only when the zoom changes, never on a pan.
  const zoom = transform.k;
  const names = useMemo((): GroupNameSpot[] => {
    if (!layout || !measures) return [];
    return model.asks.flatMap((ask) => {
      const group = layout.groups.get(ask.id);
      const name = group ? groupNameAt(ask, group, zoom, measures, BADGE_RADIUS) : null;
      return name ? [name] : [];
    });
  }, [layout, measures, model, zoom]);

  const toolLabels = useMemo((): MapLabel[] => {
    if (!layout || !marks || !size || !measures) return [];
    const t = transform;
    const resting = restingLabelIds(
      marks.marks.map((mark) => ({ id: mark.id, weight: mark.weight })),
    );
    const ranked: Array<LabelChoice<MapLabel>> = [];
    const seen = new Set<string>();
    const add = (id: string | null | undefined, force = false) => {
      if (!id || seen.has(id)) return;
      const node = layout.nodes.get(id);
      const mark = marks.byId.get(id);
      const capability = mark ? capabilitiesById.get(mark.capability) : undefined;
      if (!node || !mark || !capability) return;
      if (
        !force &&
        !(t.k >= ALL_TOOL_LABELS_AT || (t.k >= RESTING_TOOL_LABELS_AT && resting.has(id)))
      )
        return;
      seen.add(id);
      ranked.push({ ...toolLabel(capability, node, t, measures), fallback: force });
    };
    // The mark the lines leave from is named however crowded; an open tool's busiest mark next.
    add(lines?.from, true);
    add(selected && !asksById.has(selected) ? primaryMark(selected)?.id : null, true);
    for (const mark of marks.marks) add(mark.id);
    // Intent names, warning marks and other tools are in the way; a name is
    // never covered, a mark only by a lit tool's name when nothing else fits.
    const obstacles: LabelObstacle[] = [
      ...[...layout.nodes.values()].map((node) => ({
        id: `mark:${node.id}`,
        x: node.x * t.k + t.x,
        y: node.y * t.k + t.y,
        r: node.r * t.k + 2,
        soft: true,
      })),
      ...model.asks.flatMap((ask) => {
        const group = layout.groups.get(ask.id);
        if (!group || ask.problem === null) return [];
        return [
          {
            id: `badge:${ask.id}`,
            x: group.badge.x * t.k + t.x,
            y: group.badge.y * t.k + t.y,
            r: BADGE_RADIUS,
          },
        ];
      }),
    ];
    // Tool names stay above the bottom strip, where the readout and the legend sit, and off every intent's name.
    const spots = placeLabelChoices(
      ranked,
      obstacles,
      { width: size.width, height: Math.max(0, size.height - CHROME_STRIP) },
      3,
      names.map((name) => nameBox(name, t)),
    );
    return ranked.flatMap((choice) => {
      const spot = spots.get(choice.id);
      return spot ? [spot] : [];
    });
  }, [
    asksById,
    capabilitiesById,
    layout,
    lines,
    marks,
    measures,
    model,
    names,
    primaryMark,
    selected,
    size,
    transform,
  ]);

  const readout = (() => {
    const id = activeId ?? selected;
    if (!id) return null;
    const ask = asksById.get(id);
    if (ask) return { kind: "ask" as const, ask, tools: toolCount.get(id) ?? 0 };
    const capability = capabilitiesById.get(marks?.byId.get(id)?.capability ?? id);
    return capability ? { kind: "capability" as const, capability } : null;
  })();

  // The card beside an intent pointed at or focused by keyboard: its tools, as pins.
  const cardAsk = [hoverId, keyboardId].find((id) => id !== null && asksById.has(id)) ?? null;
  const cardGroup = cardAsk && layout ? (layout.groups.get(cardAsk) ?? null) : null;
  // The blob's box on screen, in whole pixels, so the card is placed again only when it moves.
  const box = cardGroup
    ? [
        Math.round(cardGroup.blob.bounds.minX * transform.k + transform.x),
        Math.round(cardGroup.blob.bounds.minY * transform.k + transform.y),
        Math.round((cardGroup.blob.bounds.maxX - cardGroup.blob.bounds.minX) * transform.k),
        Math.round((cardGroup.blob.bounds.maxY - cardGroup.blob.bounds.minY) * transform.k),
      ]
    : null;
  const [boxLeft, boxTop, boxWidth, boxHeight] = box ?? [null, null, null, null];
  const cardBlob = useMemo(
    () =>
      boxLeft === null
        ? null
        : { left: boxLeft, top: boxTop!, width: boxWidth!, height: boxHeight! },
    [boxLeft, boxTop, boxWidth, boxHeight],
  );

  if (model.asks.length === 0) {
    return (
      <div className={cn("rounded-lg border border-line bg-app dot-grid-fade", className)}>
        <EmptyState
          emblem
          title="No intents on the map yet"
          description="Intents appear here once people's asks are read and their turns call tools."
        />
      </div>
    );
  }

  const t = transform;
  // Lit and selected outlines are drawn last, so they read over the ones beside them.
  const outlineOrder = [...model.asks].sort(
    (a, b) => outlineRank(askState(a.id)) - outlineRank(askState(b.id)),
  );
  return (
    <div
      ref={containerRef}
      data-intent-map=""
      data-state={
        failed
          ? "failed"
          : layout && real && placed?.key === layoutKey && placed.atRealSize
            ? "ready"
            : size
              ? "laying-out"
              : "measuring"
      }
      className={cn(
        "relative h-[min(640px,72dvh)] min-h-[420px] overflow-hidden rounded-lg border border-line bg-app",
        className,
      )}
    >
      {/* The dot grid, faint, panning with the drawing; blobs cover it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 dot-grid opacity-45"
        style={{ backgroundPosition: `${4 + (t.x % 8)}px ${4 + (t.y % 8)}px` }}
      />
      {failed ? (
        <div className="relative p-4">
          <Callout tone="warning" title="The map could not be drawn">
            All intents lists the same intents.
          </Callout>
        </div>
      ) : !layout || !real ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <MapLoader label="Drawing the intent map" />
        </div>
      ) : null}
      {layout && marks && size ? (
        <svg
          ref={svgRef}
          width={size.width}
          height={size.height}
          role="group"
          aria-label={`Intent map: ${model.asks.length} intents and the tools their asks used. Arrow keys move between them, Enter opens one.`}
          className="absolute inset-0 block cursor-grab touch-none select-none active:cursor-grabbing"
          onKeyDown={onKeyDown}
          onPointerDown={() => setFoundId(null)}
          onClick={(event) => {
            if (event.target === event.currentTarget) onClear();
          }}
        >
          <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
            <g aria-hidden className="pointer-events-none">
              {model.asks.map((ask) => {
                const group = layout.groups.get(ask.id);
                return group ? <GroupBase key={ask.id} path={group.blob.path} /> : null;
              })}
            </g>
            {model.asks.map((ask) => {
              const group = layout.groups.get(ask.id);
              if (!group) return null;
              return (
                <Group
                  key={ask.id}
                  ask={ask}
                  path={group.blob.path}
                  state={askState(ask.id)}
                  tabIndex={tabStop === ask.id ? 0 : -1}
                  tools={toolCount.get(ask.id) ?? 0}
                  onHover={setHoverId}
                  onOpen={onOpen}
                  onFocus={onNodeFocus}
                  onBlur={() => setKeyboardId(null)}
                />
              );
            })}
            <g aria-hidden className="pointer-events-none">
              {outlineOrder.map((ask) => {
                const group = layout.groups.get(ask.id);
                return group ? (
                  <GroupOutline key={ask.id} path={group.blob.path} state={askState(ask.id)} />
                ) : null;
              })}
            </g>
            <g aria-hidden className="pointer-events-none">
              {names.map((name) => (
                <GroupName
                  key={name.id}
                  x={name.x}
                  y={name.y}
                  lines={name.lines}
                  fontSize={name.fontSize}
                  lineHeight={name.lineHeight}
                  state={askState(name.id)}
                />
              ))}
            </g>
            {lines ? <ToolLines from={lines.source} to={lines.targets} tint={lines.tint} /> : null}
            {marks.marks.map((mark) => {
              const node = layout.nodes.get(mark.id);
              const capability = capabilitiesById.get(mark.capability);
              if (!node || !capability) return null;
              return (
                <Mark
                  key={mark.id}
                  capability={capability}
                  mark={mark}
                  node={node}
                  state={markState(mark)}
                  tabIndex={tabStop === mark.id ? 0 : -1}
                  onHover={setHoverId}
                  onOpen={onOpen}
                  onFocus={onNodeFocus}
                  onBlur={() => setKeyboardId(null)}
                />
              );
            })}
          </g>
          <g aria-hidden className="pointer-events-none">
            {/* An intent with a problem wears a warning mark on its outline: a shape as well as a color, never an amber outline. */}
            {model.asks.map((ask) => {
              const group = layout.groups.get(ask.id);
              if (!group || ask.problem === null || (anyLit && !askLit(ask.id))) return null;
              return (
                <WarningBadge
                  key={`badge-${ask.id}`}
                  x={group.badge.x * t.k + t.x}
                  y={group.badge.y * t.k + t.y}
                />
              );
            })}
            {toolLabels.map((label) => (
              <text
                key={label.id}
                x={label.textX}
                y={label.textY}
                textAnchor={label.anchor}
                dominantBaseline="central"
                className={cn(
                  "font-mono text-xs [paint-order:stroke] stroke-app [stroke-linejoin:round] [stroke-width:3px]",
                  markLit(label.id) ? "fill-fg" : "fill-fg-subtle",
                  anyLit && !markLit(label.id) && "opacity-40",
                )}
              >
                {label.lines.map((line, index) => (
                  <tspan key={index} x={label.textX} dy={index === 0 ? 0 : TOOL_LINE_HEIGHT}>
                    {line}
                  </tspan>
                ))}
              </text>
            ))}
          </g>
        </svg>
      ) : null}
      {cardAsk && cardBlob && marks && size ? (
        <IntentCard
          key={cardAsk}
          ask={asksById.get(cardAsk)!}
          marks={marks.byAsk.get(cardAsk) ?? []}
          capabilities={capabilitiesById}
          blob={cardBlob}
          view={size}
        />
      ) : null}
      <MapReadout
        readout={readout}
        hidden={model.hidden}
        totals={{ asks: model.asks.length, capabilities: model.capabilities.length }}
      />
      <MapLegend
        problem={model.asks.find((ask) => ask.problem !== null)?.problem ?? null}
        tinted={
          model.asks.some((ask) => Boolean(ask.tint)) ||
          model.capabilities.some((capability) => Boolean(capability.tint))
        }
        missing={model.capabilities.some((capability) => capability.missing)}
        skills={model.capabilities.some((capability) => capability.kind === "skill")}
        shared={Boolean(marks?.marks.some((mark) => mark.shared))}
      />
    </div>
  );
}

/** Outlines that matter more are drawn later, on top. */
function outlineRank(state: NodeState): number {
  return state === "selected" || state === "focused"
    ? 3
    : state === "lit"
      ? 2
      : state === "rest"
        ? 1
        : 0;
}
