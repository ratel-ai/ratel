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
import type { MapLabel } from "@/components/console/intent-map/labels";
import { MapLoader } from "@/components/console/intent-map/MapLoader";
import { type NodeState, WarningBadge } from "@/components/console/intent-map/MapMarks";
import {
  createTextMeasures,
  MEASURE_PX,
  type TextMeasures,
} from "@/components/console/intent-map/measure";
import {
  LinkExplanation,
  NetworkLegend,
  NetworkReadout,
  type NetworkReadoutState,
  strongestPartners,
} from "@/components/console/intent-map/NetworkChrome";
import {
  HomeLabel,
  type HullTone,
  type LinkTone,
  NetworkGlobe,
  NetworkHull,
  NetworkLinkMark,
  NetworkNodeMark,
} from "@/components/console/intent-map/NetworkMarks";
import {
  badgeAt,
  globeSides,
  LABEL_FONT_PX,
  LABEL_HEIGHT,
  networkLabels,
} from "@/components/console/intent-map/network-labels";
import { useNodeDrag } from "@/components/console/intent-map/use-node-drag";
import { captureClientException } from "@/lib/platform/track-client";
import {
  type Bounds,
  type Circle,
  centreOn,
  constrainView,
  fitTransform,
  type LabelChoice,
  type LabelObstacle,
  lerpTransform,
  type Point,
  placeLabelChoices,
  type ViewTransform,
  zoomFloor,
} from "@/lib/views/intents/map/map-geometry";
import type { IntentMapModel } from "@/lib/views/intents/map/map-model";
import { globeLayout } from "@/lib/views/intents/map/tool-globe";
import { OTHER_HOME, type ToolHome, toolHomes } from "@/lib/views/intents/map/tool-homes";
import {
  buildToolNetwork,
  type GroupColor,
  linkReasons,
  networkLayoutKey,
  networkNeighbours,
  STRENGTH_FLOOR,
  type ToolStep,
} from "@/lib/views/intents/map/tool-network";
import {
  boundsWithNames,
  groupHull,
  linkShape,
  type NameSide,
  networkBounds,
  networkRadius,
  nudgeIntoView,
  type ScreenBox,
} from "@/lib/views/intents/map/tool-network-layout";

/**
 * The tool network (DESIGN.md, Data visualization) as a globe: every tool in
 * its home, one disc for all of them. A home is a task (its hull in the task's
 * color, gray past the three colored tasks), Shared (tools many tasks run, in
 * the middle, ringed) or, for tools no task runs, the dashed ring around the
 * disc (`tool-homes`, `tool-globe`). Two tools are linked when they serve the
 * same intents, or when one came right after the other in a turn (then the
 * link has an arrow). Calm at rest: only the links inside a home and the
 * strongest across homes; each home named like a pin; tool names wherever
 * they fit, facing out of the disc. Point at a tool and its partners light
 * (hidden links included) while the rest dim; point at a link and it says why
 * the two are linked.
 *
 * Pan by dragging the canvas; drag a tool to move it (nothing else moves).
 * Zoom with the buttons, a pinch, or ⌘/Ctrl and scroll; pan and zoom are
 * bounded exactly as on the map (`constrainView`, `zoomFloor`). Zoomed in,
 * every tool is named. The keyboard walks the tools home by home with the
 * arrow keys; Enter opens one, Esc clears.
 *
 * The layout is worked out once per network, before the first paint, and is
 * the same every time for the same tools and tasks; nothing jitters.
 * Reusable: it reads only the plain model and reports ids; selection lives
 * with the caller (the URL).
 */

export type ToolNetworkHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  /** Centre a tool and light it, e.g. from search. */
  flyTo: (id: string) => void;
};

/** Zoom range; the floor is raised to `zoomFloor` of the fitted view once it is known. */
const SCALE = { min: 0.2, max: 4 };
const FIT_SCALE = { min: 0.2, max: 1.35 };
/** From this zoom every tool is named, however crowded. */
const ALL_LABELS_AT = 1.6;
const FLY_MS = 380;
/** Height of the strip along the bottom that the readout and legend sit in. */
const CHROME_STRIP = 40;
/** Below this much uncovered width (a phone, where a panel covers the page) the view is left alone. */
const MIN_UNCOVERED = 280;
/** Room around the drawing when it is fitted (map units); the names at its edge get their own. */
const FIT_ROOM = 24;
/** Room for the names may shrink the fitted drawing to this share of its own fit, no further. */
const NAME_ROOM_FLOOR = 0.75;
/** A home's name sits this far (screen pixels) above its hull, or below it when another name is in the way. */
const HOME_LABEL_GAP = 11;
/** A home's name may run this far past its hull (screen pixels), then is cut; when that does not fit, it is cut shorter. */
const HOME_LABEL_ROOM = [200, 140, 96];

type Hover = { kind: "node"; id: string } | { kind: "link"; id: string } | null;

/** A home's name as placed on screen: the box it takes and where its mark and text start. */
type HomeName = {
  id: string;
  kind: ToolHome["kind"];
  color: GroupColor | null;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** `text` cut with an ellipsis to fit `width` (measured at `MEASURE_PX`). */
function fitText(text: string, width: number, measure: (text: string) => number): string {
  if (measure(text) <= width) return text;
  for (let length = text.length - 1; length > 3; length -= 1) {
    const cut = `${text.slice(0, length).trimEnd()}…`;
    if (measure(cut) <= width) return cut;
  }
  return `${text.slice(0, 3)}…`;
}

export function ToolNetwork({
  model,
  steps,
  selectedId,
  onOpen,
  onClear,
  obscuredRight,
  ref,
  className,
}: {
  model: IntentMapModel;
  /** "Came next" counts, when the loader has them. */
  steps?: readonly ToolStep[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onClear: () => void;
  /** Pixels at the window's right edge that the caller covers while a tool is open (its panel). */
  obscuredRight?: () => number;
  ref?: Ref<ToolNetworkHandle>;
  className?: string;
}) {
  const pathname = usePathname();
  const reducedMotion = usePrefersReducedMotion();
  const network = useMemo(() => buildToolNetwork({ model, steps }), [model, steps]);
  const homes = useMemo(() => toolHomes(model, network), [model, network]);
  const homeById = useMemo(() => new Map(homes.homes.map((home) => [home.id, home])), [homes]);
  const homeOf = useCallback(
    (id: string) => homeById.get(homes.homeOf.get(id) ?? "") ?? null,
    [homeById, homes],
  );
  const byTask = homes.homes.some((home) => home.kind === "task");
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<{
    behavior: ZoomBehavior<SVGSVGElement, unknown>;
    selection: Selection<SVGSVGElement, unknown, null, undefined>;
    identity: ZoomTransform;
  } | null>(null);
  const transformRef = useRef<ViewTransform>({ x: 0, y: 0, k: 1 });
  const limitsRef = useRef<{
    bounds: Bounds;
    view: { width: number; height: number };
    floor: number;
  } | null>(null);
  /** Whether the reader has moved the view (or a tool); until then it stays fitted as the view resizes. */
  const touchedRef = useRef(false);
  const frameRef = useRef(0);
  const keepClearRef = useRef<() => void>(() => {});
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [measures, setMeasures] = useState<TextMeasures | null>(null);
  /** Tools the reader dragged, where they were dropped (map units), for the layout they were dropped on. */
  const [moved, setMoved] = useState<{ key: string; points: ReadonlyMap<string, Point> } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const [transform, setTransform] = useState<ViewTransform>({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<Hover>(null);
  const [keyboardId, setKeyboardId] = useState<string | null>(null);
  /** A tool found by search stays lit until the reader points at something else. */
  const [foundId, setFoundId] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);

  // The globe: worked out from the tools and their homes alone, so the same network always draws the same.
  const layoutKey = useMemo(
    () =>
      JSON.stringify([
        networkLayoutKey(network),
        homes.homes.map((home) => [home.id, home.members]),
      ]),
    [homes, network],
  );
  const radius = useMemo(() => {
    const most = Math.max(1, ...network.nodes.map((node) => node.calls));
    return new Map(network.nodes.map((node) => [node.id, networkRadius(node.calls, most)]));
  }, [network]);
  const globe = useMemo(
    () =>
      globeLayout(
        homes.homes.map((home) => ({
          id: home.id,
          members: home.members.filter((id) => radius.has(id)),
          ring: home.kind === "other",
        })),
        radius,
      ),
    [homes, radius],
  );
  const nodesById = useMemo(() => new Map(network.nodes.map((node) => [node.id, node])), [network]);
  const linksById = useMemo(() => new Map(network.links.map((link) => [link.id, link])), [network]);
  // With task colors on the model, a tool wears its main task's color; otherwise its group's hue.
  const tints = useMemo(() => {
    if (!model.capabilities.some((capability) => capability.tint !== undefined)) return null;
    return new Map(
      model.capabilities.map((capability) => [capability.id, capability.tint ?? null]),
    );
  }, [model]);
  const colorOf = useCallback(
    (id: string): GroupColor | null => {
      if (tints) return tints.get(id) ?? null;
      const home = homeOf(id);
      return home?.kind === "group" ? home.slot : null;
    },
    [homeOf, tints],
  );
  const askLabels = useMemo(() => new Map(model.asks.map((ask) => [ask.id, ask.label])), [model]);
  /** Keyboard order: home by home, in the order they are packed, each home's tools in order. */
  const order = useMemo(
    () => homes.homes.flatMap((home) => home.members.filter((id) => nodesById.has(id))),
    [homes, nodesById],
  );
  const shared = useMemo(
    () =>
      new Set(homes.homes.filter((home) => home.kind === "shared").flatMap((home) => home.members)),
    [homes],
  );

  // Measured at once when the canvas mounts (a hidden tab or a streamed page may never run a resize
  // callback), then kept current.
  const drawable = model.capabilities.length > 0;
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
  }, [drawable]);

  // Names are measured in the page's own fonts, once they are ready.
  useEffect(() => {
    let cancelled = false;
    createTextMeasures().then(
      (next) => {
        if (!cancelled) setMeasures(next);
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
  }, [pathname]);

  const real = size !== null && size.width > 0 && size.height > 0;
  // Every tool where the globe put it, or where the reader dropped it.
  const marks = useMemo((): Map<string, Circle> | null => {
    if (!measures) return null;
    const points = moved && moved.key === layoutKey ? moved.points : null;
    if (!points || points.size === 0) return globe.marks;
    return new Map(
      [...globe.marks].map(([id, mark]) => [
        id,
        points.has(id) ? { ...mark, ...points.get(id)! } : mark,
      ]),
    );
  }, [globe, layoutKey, measures, moved]);

  const hulls = useMemo(() => {
    if (!marks) return [];
    return homes.homes.flatMap((home) => {
      if (home.kind === "other") return [];
      const discs = home.members.flatMap((id) => {
        const mark = marks.get(id);
        return mark ? [mark] : [];
      });
      const hull = groupHull(home.id, discs);
      const tone: HullTone = home.kind === "shared" ? "shared" : (home.slot ?? "neutral");
      return hull ? [{ id: home.id, home, tone, members: new Set(home.members), ...hull }] : [];
    });
  }, [homes, marks]);

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
    if (!marks) return null;
    const circles = [
      globe.disc,
      ...(globe.ring
        ? [{ ...globe.ring, r: globe.ring.r + Math.max(0, ...[...radius.values()]) }]
        : []),
    ];
    const bounds = networkBounds(marks.values(), [
      ...hulls.map((hull) => hull.bounds),
      ...circles.map((circle) => ({
        minX: circle.x - circle.r,
        minY: circle.y - circle.r,
        maxX: circle.x + circle.r,
        maxY: circle.y + circle.r,
      })),
    ]);
    if (!bounds) return null;
    return {
      minX: bounds.minX - FIT_ROOM,
      minY: bounds.minY - FIT_ROOM,
      maxX: bounds.maxX + FIT_ROOM,
      maxY: bounds.maxY + FIT_ROOM,
    };
  }, [globe, hulls, marks, radius]);
  /** Which side of its mark each tool's name goes first: out of the disc. */
  const sides = useMemo(() => (marks ? globeSides(marks) : new Map<string, NameSide>()), [marks]);
  const nameWidths = useMemo(
    () =>
      measures
        ? new Map(
            network.nodes.map((node) => [
              node.id,
              measures.mono(node.name) * (LABEL_FONT_PX / MEASURE_PX),
            ]),
          )
        : null,
    [measures, network],
  );
  /** The drawing with room for every name on the side it faces, at zoom `k`. */
  const boundsAt = useCallback(
    (k: number): Bounds | null => {
      if (!drawingBounds || !marks || !nameWidths) return drawingBounds;
      const names = network.nodes.flatMap((node) => {
        const mark = marks.get(node.id);
        return mark
          ? [
              {
                mark,
                side: sides.get(node.id) ?? ("right" as const),
                width: nameWidths.get(node.id) ?? 0,
              },
            ]
          : [];
      });
      return boundsWithNames(drawingBounds, names, k, 5, LABEL_HEIGHT);
    },
    [drawingBounds, marks, nameWidths, network, sides],
  );
  const fitTarget = useCallback((): ViewTransform | null => {
    if (!drawingBounds || !size || size.width <= 0 || size.height <= 0) return null;
    // The bottom strip holds the readout and the legend; the drawing fits above it. Names keep their
    // size on screen, so the fit is worked out twice more with room for them at the zoom found.
    const height = Math.max(1, size.height - CHROME_STRIP);
    const marksOnly = fitTransform(drawingBounds, size.width, height, 12, FIT_SCALE);
    let target = marksOnly;
    for (let pass = 0; pass < 2; pass += 1)
      target = fitTransform(boundsAt(target.k) ?? drawingBounds, size.width, height, 12, FIT_SCALE);
    if (target.k >= marksOnly.k * NAME_ROOM_FLOOR) return target;
    // A narrow view cannot hold every name: the drawing stays large and centred, and names show where they fit.
    const k = marksOnly.k * NAME_ROOM_FLOOR;
    return {
      k,
      x: size.width / 2 - ((drawingBounds.minX + drawingBounds.maxX) / 2) * k,
      y: height / 2 - ((drawingBounds.minY + drawingBounds.maxY) / 2) * k,
    };
  }, [boundsAt, drawingBounds, size]);
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

  const positionOf = useCallback((id: string): Circle | null => marks?.get(id) ?? null, [marks]);

  // Dragging a tool moves that tool only, and leaves it where it is dropped.
  const drag = useNodeDrag({
    positionOf,
    scale: () => transformRef.current.k,
    onDrag: (id, at) => {
      touchedRef.current = true;
      setMoved((current) => {
        const points = new Map(current && current.key === layoutKey ? current.points : []);
        points.set(id, at);
        return { key: layoutKey, points };
      });
    },
  });

  const flyTo = useCallback(
    (id: string) => {
      const point = positionOf(id);
      if (!point || !size) return;
      touchedRef.current = true;
      animateTo(centreOn(point, size.width, size.height, Math.max(transformRef.current.k, 1.3)));
      const index = order.indexOf(id);
      if (index >= 0) setFocusIndex(index);
      setHover(null);
      setFoundId(id);
    },
    [animateTo, order, positionOf, size],
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
  // fits it whole. A press on a tool drags the tool, never the view.
  const drawn = marks !== null && size !== null;
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
          // A plain wheel scrolls the page; ⌘/Ctrl and a trackpad pinch zoom. A press on a tool is the tool's.
          .filter((event: Event) =>
            event.type === "wheel"
              ? (event as WheelEvent).ctrlKey || (event as WheelEvent).metaKey
              : !(event as MouseEvent).button &&
                !(event.target instanceof Element && event.target.closest("[data-node]")),
          )
          .on("zoom", (event: { transform: ZoomTransform; sourceEvent: Event | null }) => {
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

  // The bounds follow the drawing (a dragged tool and the names included) and the view; the zoom floor
  // follows the fitted view.
  useEffect(() => {
    const target = fitTarget();
    if (!drawingBounds || !size || !target) return;
    const floor = zoomFloor(target.k);
    limitsRef.current = {
      bounds: boundsAt(target.k) ?? drawingBounds,
      view: { width: size.width, height: size.height },
      floor,
    };
    zoomRef.current?.behavior.scaleExtent([floor, SCALE.max]);
  }, [boundsAt, drawingBounds, fitTarget, size]);

  // Until the reader moves it, the view stays fitted as the canvas resizes.
  useEffect(() => {
    if (!zoomRef.current || touchedRef.current) return;
    const target = fitTarget();
    if (target) apply(target);
  }, [apply, fitTarget]);

  const known = (id: string | null) => (id !== null && nodesById.has(id) ? id : null);
  const selected = known(selectedId);
  const hoverNode = hover?.kind === "node" ? hover.id : null;
  const hoverLink = hover?.kind === "link" ? (linksById.get(hover.id) ?? null) : null;
  const activeId = hoverNode ?? (hoverLink ? null : (keyboardId ?? foundId ?? selected));
  const active = useMemo((): Set<string> => {
    if (hoverLink) return new Set([hoverLink.source, hoverLink.target]);
    return activeId ? networkNeighbours(network, activeId) : new Set();
  }, [activeId, hoverLink, network]);
  const pinned = useMemo(
    () => (selected && selected !== activeId ? networkNeighbours(network, selected) : null),
    [activeId, network, selected],
  );
  const anyLit = active.size > 0;
  const isLit = (id: string) => active.has(id) || Boolean(pinned?.has(id));
  const stateOf = (id: string): NodeState =>
    selected === id
      ? "selected"
      : keyboardId === id
        ? "focused"
        : isLit(id)
          ? "lit"
          : anyLit
            ? "dim"
            : "rest";
  /** At rest only a home's own links show, and the strongest between homes; the rest wait for a tool to be lit. */
  const atRest = (link: { source: string; target: string; backbone: boolean; strength: number }) =>
    link.backbone &&
    (homes.homeOf.get(link.source) === homes.homeOf.get(link.target) ||
      link.strength >= STRENGTH_FLOOR);
  const toneOf = (link: {
    id: string;
    source: string;
    target: string;
    backbone: boolean;
    strength: number;
  }): LinkTone | null => {
    const touches = (id: string | null) =>
      id !== null && (link.source === id || link.target === id);
    const resting = atRest(link);
    if (hoverLink) return hoverLink.id === link.id ? "lit" : resting ? "dim" : null;
    if (touches(activeId) || touches(selected)) return "lit";
    if (!resting) return null;
    return anyLit ? "dim" : "rest";
  };
  const hullState = (members: ReadonlySet<string>): "rest" | "lit" | "dim" =>
    [...members].some((id) => isLit(id)) ? "lit" : anyLit ? "dim" : "rest";

  const obscuredRef = useRef(obscuredRight);
  useEffect(() => {
    obscuredRef.current = obscuredRight;
  }, [obscuredRight]);
  const keepClear = useCallback(() => {
    const container = containerRef.current;
    const cover = obscuredRef.current;
    const point = selected ? positionOf(selected) : null;
    if (!container || !cover || !point || !selected || !zoomRef.current) return;
    const visible = window.innerWidth - cover() - container.getBoundingClientRect().left;
    if (visible < MIN_UNCOVERED || visible >= container.clientWidth) return;
    const t = transformRef.current;
    const reach = (point.r + 8) * t.k + 24;
    if (point.x * t.k + t.x + reach <= visible) return;
    touchedRef.current = true;
    animateTo({ k: t.k, x: visible / 2 - point.x * t.k, y: t.y });
  }, [animateTo, positionOf, selected]);
  useEffect(() => {
    keepClearRef.current = keepClear;
    keepClear();
  }, [keepClear]);

  // One tab stop, always on a drawn tool: the last one focused, else the first.
  const drawnOrder = marks ? order.filter((id) => marks.has(id)) : [];
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
      setHover(null);
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
      onOpen(id);
    }
  }

  function onNodeFocus(event: FocusEvent<SVGGElement>, id: string) {
    const index = order.indexOf(id);
    if (index >= 0) setFocusIndex(index);
    if (!event.currentTarget.matches(":focus-visible")) return;
    setKeyboardId(id);
    // Keep the focused tool in view (above the bottom strip): a keyboard reader cannot drag the canvas
    // to it, so the drawing pans as little as it must.
    const point = positionOf(id);
    if (point && size) {
      const t = transformRef.current;
      const next = nudgeIntoView(point, t, {
        width: size.width,
        height: Math.max(1, size.height - CHROME_STRIP),
      });
      if (next.x !== t.x || next.y !== t.y) {
        touchedRef.current = true;
        animateTo(next);
      }
    }
  }

  function onNodeClick(id: string) {
    if (!drag.endedDrag()) onOpen(id);
  }
  // While a tool is dragged, it stays the lit one.
  const onNodeHover = (id: string | null) => {
    if (!drag.dragging()) setHover(id ? { kind: "node", id } : null);
  };
  const onLinkHover = (id: string | null) => {
    if (!drag.dragging()) setHover(id ? { kind: "link", id } : null);
  };

  const nameOf = useCallback((id: string) => nodesById.get(id)?.name ?? id, [nodesById]);
  const labelOf = useCallback((askId: string) => askLabels.get(askId) ?? null, [askLabels]);

  const t = transform;

  // Each home named like a pin, on top of its hull; the ring at its top.
  // A name that finds no room is cut shorter and tried again, so every home stays named.
  const homeNames = useMemo((): HomeName[] => {
    if (!measures || !size) return [];
    const view = transform;
    const measure = (text: string) => measures.sans(text);
    const area = { width: size.width, height: Math.max(0, size.height - CHROME_STRIP) };
    const wanted: Array<{ home: ToolHome; x: number; above: number; below: number; hull: number }> =
      hulls.map((hull) => {
        const { minX, minY, maxX, maxY } = hull.bounds;
        return {
          home: hull.home,
          x: ((minX + maxX) / 2) * view.k + view.x,
          above: minY * view.k + view.y - HOME_LABEL_GAP,
          below: maxY * view.k + view.y + HOME_LABEL_GAP,
          hull: (maxX - minX) * view.k,
        };
      });
    const other = homeById.get(OTHER_HOME);
    if (other && globe.ring) {
      wanted.push({
        home: other,
        x: globe.ring.x * view.k + view.x,
        above: (globe.ring.y - globe.ring.r) * view.k + view.y - HOME_LABEL_GAP,
        below: (globe.ring.y + globe.ring.r) * view.k + view.y + HOME_LABEL_GAP,
        hull: 0,
      });
    }
    // Tools' marks are in the way, softly: a name would rather move than cover one.
    const obstacles: LabelObstacle[] = marks
      ? [...marks].map(([id, mark]) => ({
          id: `mark:${id}`,
          x: mark.x * view.k + view.x,
          y: mark.y * view.k + view.y,
          r: mark.r * view.k + 4,
          soft: true,
        }))
      : [];
    const placed: HomeName[] = [];
    for (const want of wanted) {
      for (const room of HOME_LABEL_ROOM) {
        const text = fitText(want.home.name, Math.max(room, want.hull) - 15, measure);
        const width = 15 + measure(text);
        const base = {
          id: want.home.id,
          kind: want.home.kind,
          color: want.home.slot,
          text,
          width,
          height: LABEL_HEIGHT,
          x: want.x,
        };
        // On top of its own hull, where its region keeps room for it; the ring's at its top, or its foot.
        const spots = (want.home.kind === "other" ? [want.above, want.below] : [want.above]).map(
          (y) => ({ ...base, y }),
        );
        const choice: LabelChoice<HomeName> = {
          id: want.home.id,
          spots,
          fallback: room === HOME_LABEL_ROOM.at(-1),
        };
        const at = placeLabelChoices([choice], obstacles, area, 4, placed).get(want.home.id);
        if (at) {
          placed.push(at);
          break;
        }
      }
    }
    return placed;
  }, [globe, homeById, hulls, marks, measures, size, transform]);

  const labels = useMemo((): MapLabel[] => {
    if (!marks || !size || !nameWidths) return [];
    return networkLabels({
      network,
      marks,
      sides,
      widths: nameWidths,
      view: transform,
      area: { width: size.width, height: Math.max(0, size.height - CHROME_STRIP) },
      // The lit tool, the open one, a hovered link's two ends and a lit tool's partners are what the reader is
      // looking at: named however crowded. The open tool's partners next, while a hover lights another, then
      // the tools many tasks share.
      must: [activeId, selected, hoverLink?.source ?? null, hoverLink?.target ?? null, ...active],
      also: [...(pinned ?? []), ...shared],
      everyName: transform.k >= ALL_LABELS_AT,
      taken: homeNames,
      ringed: shared,
    });
  }, [
    active,
    activeId,
    homeNames,
    hoverLink,
    marks,
    nameWidths,
    network,
    pinned,
    selected,
    shared,
    sides,
    size,
    transform,
  ]);

  // Why the link under the pointer exists, anchored at its middle, clear of its two tools and their names.
  const explanation = useMemo(() => {
    if (!hoverLink || !marks) return null;
    const source = marks.get(hoverLink.source);
    const target = marks.get(hoverLink.target);
    const shape = source && target ? linkShape(source, target, hoverLink.directed) : null;
    if (!source || !target || !shape) return null;
    const view = transform;
    const avoid: ScreenBox[] = [source, target].map((mark) => {
      const r = mark.r * view.k + 4;
      return {
        left: mark.x * view.k + view.x - r,
        top: mark.y * view.k + view.y - r,
        width: r * 2,
        height: r * 2,
      };
    });
    for (const label of labels) {
      if (label.id === hoverLink.source || label.id === hoverLink.target) {
        avoid.push({
          left: label.x - label.width / 2,
          top: label.y - label.height / 2,
          width: label.width,
          height: label.height,
        });
      }
    }
    return {
      names: [nameOf(hoverLink.source), nameOf(hoverLink.target)] as [string, string],
      reasons: linkReasons(hoverLink, nameOf, labelOf),
      anchor: { x: shape.mid.x * view.k + view.x, y: shape.mid.y * view.k + view.y },
      avoid,
    };
  }, [hoverLink, labelOf, labels, marks, nameOf, transform]);

  const readout = ((): NetworkReadoutState => {
    if (hoverLink) {
      return {
        kind: "link",
        link: hoverLink,
        names: [nameOf(hoverLink.source), nameOf(hoverLink.target)],
        reasons: linkReasons(hoverLink, nameOf, labelOf),
      };
    }
    const id = activeId ?? selected;
    const node = id ? nodesById.get(id) : undefined;
    const home = node ? homeOf(node.id) : null;
    return node
      ? {
          kind: "node",
          node,
          partners: strongestPartners(node.id, network.links, nameOf),
          home: home ? { kind: home.kind, name: home.name } : null,
        }
      : null;
  })();

  if (model.capabilities.length === 0) {
    return (
      <div className={cn("rounded-lg border border-line bg-app dot-grid-fade", className)}>
        <EmptyState
          emblem
          title="No tools on this graph yet"
          description="Tools appear as the asks of your intents call them."
        />
      </div>
    );
  }

  const ready = marks !== null && real;
  return (
    <div
      ref={containerRef}
      data-tool-network=""
      data-state={failed ? "failed" : ready ? "ready" : size ? "laying-out" : "measuring"}
      className={cn(
        "relative h-[min(640px,72dvh)] min-h-[420px] overflow-hidden rounded-lg border border-line bg-app",
        className,
      )}
    >
      {/* The dot grid, faint, panning with the drawing; the globe covers it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 dot-grid opacity-45"
        style={{ backgroundPosition: `${4 + (t.x % 8)}px ${4 + (t.y % 8)}px` }}
      />
      {failed ? (
        <div className="relative p-4">
          <Callout tone="warning" title="The tool network could not be drawn">
            All intents lists the same tools.
          </Callout>
        </div>
      ) : !marks || !real ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <MapLoader label="Drawing the tool network" />
        </div>
      ) : null}
      {marks && size ? (
        <svg
          ref={svgRef}
          width={size.width}
          height={size.height}
          role="group"
          aria-label={`Tool network: ${network.nodes.length} tools and skills in ${hulls.length} ${byTask ? "tasks" : "groups"}, ${network.links.length} links. Arrow keys move between them, Enter opens one.`}
          className="absolute inset-0 block cursor-grab touch-none select-none active:cursor-grabbing"
          onKeyDown={onKeyDown}
          onPointerDown={() => setFoundId(null)}
          onClick={(event) => {
            if (event.target === event.currentTarget) onClear();
          }}
        >
          <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
            <NetworkGlobe disc={globe.disc} ring={globe.ring} />
            <g aria-hidden className="pointer-events-none">
              {hulls.map((hull) => (
                <NetworkHull
                  key={hull.id}
                  id={hull.id}
                  path={hull.path}
                  color={hull.tone}
                  state={hullState(hull.members)}
                />
              ))}
            </g>
            <g aria-hidden>
              {network.links.map((link) => {
                const tone = toneOf(link);
                const source = marks.get(link.source);
                const target = marks.get(link.target);
                if (!tone || !source || !target) return null;
                const shape = linkShape(source, target, link.directed);
                if (!shape) return null;
                const sourceColor = colorOf(link.source);
                const color =
                  sourceColor !== null && sourceColor === colorOf(link.target) ? sourceColor : null;
                return (
                  <NetworkLinkMark
                    key={link.id}
                    link={link}
                    shape={shape}
                    color={color}
                    tone={tone}
                    onHover={onLinkHover}
                  />
                );
              })}
            </g>
            {network.nodes.map((node) => {
              const mark = marks.get(node.id);
              if (!mark) return null;
              return (
                <NetworkNodeMark
                  key={node.id}
                  node={node}
                  mark={mark}
                  color={colorOf(node.id)}
                  home={homeOf(node.id)?.kind ?? null}
                  state={stateOf(node.id)}
                  tabIndex={tabStop === node.id ? 0 : -1}
                  onHover={onNodeHover}
                  onFocus={onNodeFocus}
                  onBlur={() => setKeyboardId(null)}
                  onPointerDown={drag.onPointerDown}
                  onPointerMove={drag.onPointerMove}
                  onPointerUp={drag.onPointerUp}
                  onClick={onNodeClick}
                />
              );
            })}
          </g>
          <g aria-hidden className="pointer-events-none">
            {homeNames.map((name) => {
              const home = homeById.get(name.id);
              const state =
                home?.kind === "other"
                  ? home.members.some((id) => isLit(id))
                    ? "lit"
                    : anyLit
                      ? "dim"
                      : "rest"
                  : hullState(new Set(home?.members ?? []));
              return (
                <HomeLabel
                  key={name.id}
                  kind={name.kind}
                  color={name.color}
                  text={name.text}
                  x={name.x - name.width / 2}
                  y={name.y}
                  state={state}
                />
              );
            })}
            {/* A tool the catalog lost wears a warning mark: a shape as well as a color, never an outline in a task's hue. */}
            {network.nodes.map((node) => {
              const mark = marks.get(node.id);
              if (!mark || !node.missing || (anyLit && !isLit(node.id))) return null;
              const at = badgeAt(mark, t);
              return <WarningBadge key={`badge-${node.id}`} x={at.x} y={at.y} />;
            })}
            {labels.map((label) => (
              <text
                key={label.id}
                x={label.textX}
                y={label.textY}
                textAnchor={label.anchor}
                dominantBaseline="central"
                className={cn(
                  "font-mono text-xs [paint-order:stroke] stroke-app [stroke-linejoin:round] [stroke-width:3px] transition-opacity duration-120 motion-reduce:transition-none",
                  isLit(label.id)
                    ? "fill-fg"
                    : nodesById.get(label.id)?.partners === 0
                      ? "fill-fg-subtle"
                      : "fill-fg-muted",
                  anyLit && !isLit(label.id) && "opacity-35",
                )}
              >
                {label.lines[0]}
              </text>
            ))}
          </g>
        </svg>
      ) : null}
      {hoverLink && explanation && size ? (
        <LinkExplanation
          key={hoverLink.id}
          names={explanation.names}
          reasons={explanation.reasons}
          anchor={explanation.anchor}
          avoid={explanation.avoid}
          view={size}
        />
      ) : null}
      <NetworkReadout
        readout={readout}
        totals={{
          tools: network.nodes.length,
          links: network.links.length,
          shown: network.links.filter(atRest).length,
          tasks: byTask ? homes.homes.filter((home) => home.kind === "task").length : undefined,
        }}
      />
      <NetworkLegend
        groups={
          homes.homes.some((home) => home.slot !== null) ||
          [...(tints?.values() ?? [])].some(Boolean)
        }
        colorLabel={byTask ? "Task" : "Run together"}
        hubs={shared.size > 0 || (!byTask && network.nodes.some((node) => node.hub))}
        hubLabel={byTask ? "Shared by many tasks" : "Widely shared"}
        other={homes.homes.some((home) => home.kind === "other")}
        ordered={network.links.some((link) => link.directed)}
        missing={network.nodes.some((node) => node.missing)}
        skills={network.nodes.some((node) => node.kind === "skill")}
      />
    </div>
  );
}
