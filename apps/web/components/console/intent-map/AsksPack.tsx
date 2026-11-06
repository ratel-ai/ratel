"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { NounIcon } from "@ratel/design-system/entity";
import { usePrefersReducedMotion } from "@ratel/design-system/use-prefers-reduced-motion";
import { ArrowUpRight, ChevronRight, MessageSquare } from "lucide-react";
import { usePathname } from "next/navigation";
import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MapLoader } from "@/components/console/intent-map/MapLoader";
import { captureClientException } from "@/lib/platform/track-client";
import type { IntentAsksTree } from "@/lib/views/intents/asks-tree";
import {
  type AsksLabelSpot,
  type AsksLayout,
  type AsksNode,
  labelSpots,
  layoutAsks,
  type PackKit,
  pathTo,
  ROOT,
  resolveFocus,
  stepToward,
  zoomedInto,
} from "@/lib/views/intents/map/asks-pack";
import { blobOutline } from "@/lib/views/intents/map/map-blobs";
import {
  constrainView,
  fitTransform,
  lerpTransform,
  type ViewTransform,
} from "@/lib/views/intents/map/map-geometry";
import type { IntentMapModel, MapTint } from "@/lib/views/intents/map/map-model";

/** What the lens draws inside the intents: read after the page, by the caller. */
export type AsksRead =
  | { status: "loading" }
  | { status: "ready"; trees: ReadonlyMap<string, IntentAsksTree> }
  | { status: "failed" };

/** Before `d3-hierarchy` is in: nothing laid out yet. */
const EMPTY_LAYOUT: AsksLayout = {
  nodes: [],
  byKey: new Map(),
  children: new Map([[ROOT, []]]),
  bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
};

/** How long a step in or out takes. */
const GLIDE_MS = 520;
/** Height of the bar along the top that the trail sits in. */
const TRAIL = 44;
/** Room around a fitted circle, on screen. */
const FIT_PAD = { root: 28, inner: 40 };
/** Below this much uncovered width (a phone, where a panel covers the page) nothing is kept clear. */
const MIN_UNCOVERED = 280;
/** A card's width, and the most height it takes (its name stops at four lines). */
const CARD = { width: 256, height: 152 };
/**
 * Free zoom: a pinch, or ⌘/Ctrl and scroll, zooms around the pointer (`rate`
 * per wheel unit), the buttons by `step`, from a little under the fitted view
 * (`min`; under `out` it steps back out a level) up to `max` times it.
 */
const ZOOM = { rate: 0.01, step: 1.6, min: 0.85, out: 0.88, max: 40 };
/** A press that moves this far is a drag, not a click. */
const DRAG_PX = 4;

/** The lens's view controls, for the toolbar's buttons. */
export interface AsksPackHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
}

type Tone = MapTint | "neutral";
// Each tint at each depth, written out whole so the class names exist at build time.
const FILL: Record<"intent" | "group" | "way", Record<Tone, string>> = {
  intent: {
    "chart-1": "fill-chart-1/[0.08]",
    "chart-5": "fill-chart-5/[0.08]",
    "chart-4": "fill-chart-4/[0.08]",
    neutral: "fill-fg/[0.045]",
  },
  group: {
    "chart-1": "fill-chart-1/[0.12]",
    "chart-5": "fill-chart-5/[0.12]",
    "chart-4": "fill-chart-4/[0.12]",
    neutral: "fill-fg/[0.06]",
  },
  way: {
    "chart-1": "fill-chart-1/[0.28]",
    "chart-5": "fill-chart-5/[0.28]",
    "chart-4": "fill-chart-4/[0.28]",
    neutral: "fill-fg/[0.14]",
  },
};
const FILL_LIT: Record<"intent" | "group" | "way", Record<Tone, string>> = {
  intent: {
    "chart-1": "fill-chart-1/[0.14]",
    "chart-5": "fill-chart-5/[0.14]",
    "chart-4": "fill-chart-4/[0.14]",
    neutral: "fill-fg/[0.08]",
  },
  group: {
    "chart-1": "fill-chart-1/[0.2]",
    "chart-5": "fill-chart-5/[0.2]",
    "chart-4": "fill-chart-4/[0.2]",
    neutral: "fill-fg/[0.11]",
  },
  way: {
    "chart-1": "fill-chart-1/[0.45]",
    "chart-5": "fill-chart-5/[0.45]",
    "chart-4": "fill-chart-4/[0.45]",
    neutral: "fill-fg/[0.24]",
  },
};
const RING =
  "ring fill-none stroke-accent-mark [stroke-width:1.5px] transition-opacity duration-120";
/** A dark halo hugging the letters, tight then wide, so a name reads over any tint. */
const HALO =
  "[text-shadow:0_0_1px_rgb(0_0_0/0.95),0_0_4px_rgb(0_0_0/0.85),0_1px_10px_rgb(0_0_0/0.7)]";

const n = (value: number) => value.toLocaleString("en-US");
const pct = (value: number) => `${Math.round(value * 100)}%`;
const asks = (value: number) => `${n(value)} ${value === 1 ? "ask" : "asks"}`;

/** A node's name, as the page shows it: an intent's name, a thing they ask for, or an ask quoted. */
export interface AsksName {
  text: string;
  quoted: boolean;
}

/** Every node's name, from the model and the trees: text only, for the label layer, the trail and the cards. */
export function nameOf(
  node: AsksNode,
  model: IntentMapModel,
  trees: ReadonlyMap<string, IntentAsksTree>,
): AsksName {
  if (node.kind === "intent")
    return {
      text: model.asks.find((ask) => ask.id === node.intent)?.label ?? "Intent",
      quoted: false,
    };
  const group = trees.get(node.intent)?.groups.find((item) => item.id === node.group);
  if (node.kind === "rest") {
    // A rest inside a thing (or inside an intent that is one thing) stands for ways; in an intent, for things.
    const ways = node.group !== null;
    return {
      text: `${n(node.count)} more ${ways ? (node.count === 1 ? "way" : "ways") : node.count === 1 ? "thing" : "things"}`,
      quoted: false,
    };
  }
  if (node.kind === "group") return { text: group?.label ?? "", quoted: group?.quoted ?? false };
  return { text: group?.ways.find((way) => way.id === node.way)?.label ?? "", quoted: true };
}

const quote = (name: AsksName) => (name.quoted ? `“${name.text}”` : name.text);

/** Whether a click on this circle goes in (it holds circles), or picks it and pins its card. */
export const opens = (layout: AsksLayout, node: AsksNode) =>
  (node.kind === "intent" || node.kind === "group") &&
  (layout.children.get(node.key)?.length ?? 0) > 0;

/**
 * Intents › Map, the Asks lens (DESIGN.md, Data visualization): every intent
 * a soft blob in its main task's tint, as large as its asks; inside it, what
 * they ask for, each a circle as large as its share; inside each of those,
 * the ways people ask it. Click a circle to glide in one level, Esc or the
 * trail to come back out; a circle that holds nothing more is picked instead,
 * its card pinned. Zoom freely too (a pinch, ⌘/Ctrl and scroll, or the
 * buttons) and drag to pan: the labels follow the zoom, names on the circles
 * large enough, counts on the smaller ones, and a circle grown large hands
 * its centre to its own circles; zoom far enough into one and it becomes the
 * focus, out past the fitted view and the lens steps back out. Pointing names
 * the circle a click would go to. The names ride on a layer above the
 * drawing, as text, never attributes (they are people's asks). Every count
 * reads "N of" the asks read for the circle around it. Calm at rest: no
 * lines, no strokes but the focus ring. Reduced motion jumps instead of
 * gliding.
 */
export function AsksPack({
  model,
  read,
  focus,
  onFocus,
  onOpenIntent,
  panelOpen = false,
  obscuredRight,
  kit: given,
  ref,
}: {
  model: IntentMapModel;
  read: AsksRead;
  /** The focused circle's key (`?in=`); null is every intent. */
  focus: string | null;
  onFocus: (key: string | null) => void;
  /** Opens an intent's panel. */
  onOpenIntent: (topicId: string) => void;
  /** Whether the caller's panel is open, covering `obscuredRight()` pixels at the window's right edge. */
  panelOpen?: boolean;
  obscuredRight?: () => number;
  /** `d3-hierarchy`, when the caller has it already (a test); otherwise it loads with the lens. */
  kit?: PackKit;
  ref?: Ref<AsksPackHandle>;
}) {
  const pathname = usePathname();
  const reducedMotion = usePrefersReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  // `d3-hierarchy` loads with the lens, like every D3 module on the map.
  const [kit, setKit] = useState<PackKit | null>(given ?? null);
  const [drawFailed, setDrawFailed] = useState(false);
  const pathRef = useRef(pathname);
  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);
  useEffect(() => {
    if (given) return;
    let cancelled = false;
    import("d3-hierarchy").then(
      ({ hierarchy, pack }) => {
        if (!cancelled) setKit({ hierarchy, pack });
      },
      (error: unknown) => {
        // Reported, never dropped: a module that will not load is an outage worth seeing.
        captureClientException(error, {
          digest: null,
          pathname: pathRef.current ?? "",
          boundary: "app",
        });
        if (!cancelled) setDrawFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [given]);
  const trees = useMemo(
    () => (read.status === "ready" ? read.trees : new Map<string, IntentAsksTree>()),
    [read],
  );
  const intents = useMemo(
    () => model.asks.map((ask) => ({ id: ask.id, asks: ask.volume })),
    [model],
  );
  const layout = useMemo(
    () => (kit ? layoutAsks(intents, trees, kit) : EMPTY_LAYOUT),
    [kit, intents, trees],
  );
  const tints = useMemo(
    () => new Map(model.asks.map((ask) => [ask.id, (ask.tint ?? "neutral") as Tone])),
    [model],
  );
  const blobs = useMemo(
    () =>
      new Map(
        layout.nodes
          .filter((node) => node.kind === "intent")
          .map((node) => [
            node.key,
            blobOutline(node.intent, { x: node.x, y: node.y }, [
              { x: node.x, y: node.y, r: node.r },
            ]).path,
          ]),
      ),
    [layout],
  );
  const focusKey = useMemo(() => resolveFocus(layout, focus), [layout, focus]);
  const trail = useMemo(() => pathTo(layout, focusKey), [layout, focusKey]);
  const level = useMemo(() => layout.children.get(focusKey) ?? [], [layout, focusKey]);
  /** Everything inside the focus: drawn at full strength; the rest fades. */
  const inside = useMemo(() => {
    const keys = new Set<string>();
    const walk = (key: string) => {
      for (const child of layout.children.get(key) ?? []) {
        keys.add(child);
        walk(child);
      }
    };
    walk(focusKey);
    return keys;
  }, [layout, focusKey]);
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [keyboard, setKeyboard] = useState(0);
  /** A circle with keyboard focus shows its card, as a pointed-at one does. */
  const [keyFocus, setKeyFocus] = useState<string | null>(null);

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

  // The focus's circle in map units, and the view that fits it in what the trail and the panel leave.
  const focusBounds = useMemo(() => {
    const node = focusKey === ROOT ? null : layout.byKey.get(focusKey);
    return node
      ? {
          minX: node.x - node.r,
          minY: node.y - node.r,
          maxX: node.x + node.r,
          maxY: node.y + node.r,
        }
      : layout.bounds;
  }, [layout, focusKey]);
  const target = useMemo<ViewTransform | null>(() => {
    if (!size || layout.nodes.length === 0) return null;
    const cover =
      panelOpen && obscuredRight && size.width > MIN_UNCOVERED * 2
        ? Math.min(obscuredRight(), size.width - MIN_UNCOVERED)
        : 0;
    const fit = fitTransform(
      focusBounds,
      size.width - cover,
      size.height - TRAIL,
      focusKey === ROOT ? FIT_PAD.root : FIT_PAD.inner,
      { min: 0.05, max: 60 },
    );
    return { ...fit, y: fit.y + TRAIL };
  }, [size, layout, focusKey, focusBounds, panelOpen, obscuredRight]);

  // The view: glided to the fitted focus when it changes, moved freely by zoom and drag between.
  const [t, setT] = useState<ViewTransform | null>(null);
  const tRef = useRef<ViewTransform | null>(null);
  const frameRef = useRef(0);
  const view = useCallback((next: ViewTransform) => {
    tRef.current = next;
    setT(next);
  }, []);
  const glide = useCallback(
    (to: ViewTransform) => {
      cancelAnimationFrame(frameRef.current);
      const from = tRef.current;
      if (!from || reducedMotion) {
        view(to);
        return;
      }
      const start = performance.now();
      const tick = (now: number) => {
        const progress = (now - start) / GLIDE_MS;
        view(lerpTransform(from, to, progress));
        if (progress < 1) frameRef.current = requestAnimationFrame(tick);
      };
      frameRef.current = requestAnimationFrame(tick);
    },
    [reducedMotion, view],
  );
  useEffect(() => {
    if (!target) return;
    glide(target);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target, glide]);

  // A new focus starts the keyboard at its first child and lets go of a pick outside it.
  const [seenFocus, setSeenFocus] = useState(focusKey);
  if (seenFocus !== focusKey) {
    setSeenFocus(focusKey);
    setKeyboard(0);
    if (picked && !pathTo(layout, picked).includes(focusKey)) setPicked(null);
  }

  // After a step taken from the keyboard, where focus lands: the new level's first circle, or the circle just left.
  const landRef = useRef<{ on: "first" | string } | null>(null);
  const go = useCallback(
    (hit: string, fromKeyboard = false) => {
      const next = stepToward(layout, focusKey, hit);
      const node = layout.byKey.get(next);
      if (!node || next === focusKey) return;
      if (!opens(layout, node)) {
        setPicked((current) => (current === next ? null : next));
        return;
      }
      setPicked(null);
      if (fromKeyboard) landRef.current = { on: "first" };
      onFocus(next === ROOT ? null : next);
    },
    [layout, focusKey, onFocus],
  );
  const up = useCallback(
    (fromKeyboard = false) => {
      if (picked) return setPicked(null);
      if (focusKey === ROOT) return;
      const parent = layout.byKey.get(focusKey)?.parent ?? ROOT;
      if (fromKeyboard) landRef.current = { on: focusKey };
      onFocus(parent === ROOT ? null : parent);
    },
    [picked, focusKey, layout, onFocus],
  );
  useEffect(() => {
    const land = landRef.current;
    const container = containerRef.current;
    if (!land || !container) return;
    landRef.current = null;
    const index = land.on === "first" ? 0 : Math.max(0, level.indexOf(land.on));
    setKeyboard(index);
    const frame = requestAnimationFrame(() => {
      const node = level[index]
        ? container.querySelector<SVGGElement>(`[data-asks-node="${CSS.escape(level[index]!)}"]`)
        : null;
      (node ?? container).focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusKey, level]);

  // Zoom around a point: bounded to the fitted focus, stepping in or out a level at the ends.
  const stateRef = useRef({ layout, focusKey, target, focusBounds, size, go, up });
  useEffect(() => {
    stateRef.current = { layout, focusKey, target, focusBounds, size, go, up };
  }, [layout, focusKey, target, focusBounds, size, go, up]);
  /** After a step, the rest of the same gesture (a trackpad's momentum) is let go, so one pinch is one level. */
  const quietRef = useRef(0);
  const zoomBy = useCallback(
    (factor: number, x: number, y: number) => {
      const current = tRef.current;
      const {
        layout: drawn,
        focusKey: at,
        target: fit,
        focusBounds: bounds,
        size: area,
        go: goIn,
        up: goOut,
      } = stateRef.current;
      if (!current || !fit || !area || performance.now() < quietRef.current) return;
      cancelAnimationFrame(frameRef.current);
      const k = Math.min(fit.k * ZOOM.max, Math.max(fit.k * ZOOM.min, current.k * factor));
      const scaled = scaledAround(current, { scale: k / current.k, x, y });
      view(constrainView(scaled, area, bounds));
      if (factor < 1 && k <= fit.k * ZOOM.out && at !== ROOT) {
        quietRef.current = performance.now() + GLIDE_MS;
        goOut();
        return;
      }
      const into = factor > 1 ? zoomedInto(drawn, at, scaled, { x, y }, area) : null;
      if (into) {
        quietRef.current = performance.now() + GLIDE_MS;
        goIn(into);
      }
    },
    [view],
  );
  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => size && zoomBy(ZOOM.step, size.width / 2, (size.height + TRAIL) / 2),
      zoomOut: () => size && zoomBy(1 / ZOOM.step, size.width / 2, (size.height + TRAIL) / 2),
      fit: () => {
        if (target) glide(target);
      },
    }),
    [size, zoomBy, target, glide],
  );

  // Pinch and ⌘/Ctrl-scroll (Safari's gesture events too), and drag to pan.
  const dragRef = useRef<{
    x: number;
    y: number;
    from: ViewTransform;
    moved: boolean;
    pointer: number;
  } | null>(null);
  const clickAfterDragRef = useRef(false);
  const ready = t !== null && size !== null;
  useEffect(() => {
    const svg = svgRef.current;
    if (!ready || !svg) return;
    const at = (clientX: number, clientY: number) => {
      const box = svg.getBoundingClientRect();
      return { x: clientX - box.left, y: clientY - box.top };
    };
    const onWheel = (event: WheelEvent) => {
      // A plain scroll still scrolls the page; a pinch, or ⌘/Ctrl and scroll, zooms.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const point = at(event.clientX, event.clientY);
      zoomBy(Math.exp(-event.deltaY * ZOOM.rate), point.x, point.y);
    };
    // Safari reports a trackpad pinch as gesture events, with the scale since the gesture began.
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    let gestureScale = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureScale = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Gesture;
      const point = at(gesture.clientX, gesture.clientY);
      zoomBy(gesture.scale / gestureScale, point.x, point.y);
      gestureScale = gesture.scale;
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("gesturestart", onGestureStart, { passive: false });
    svg.addEventListener("gesturechange", onGestureChange, { passive: false });
    return () => {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("gesturestart", onGestureStart);
      svg.removeEventListener("gesturechange", onGestureChange);
    };
  }, [ready, zoomBy]);
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !tRef.current) return;
    cancelAnimationFrame(frameRef.current);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      from: tRef.current,
      moved: false,
      pointer: event.pointerId,
    };
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || !size) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      drag.moved = true;
      event.currentTarget.setPointerCapture(drag.pointer);
      setHover(null);
    }
    view(
      constrainView(
        { k: drag.from.k, x: drag.from.x + dx, y: drag.from.y + dy },
        size,
        focusBounds,
      ),
    );
  };
  const onPointerUp = () => {
    if (dragRef.current?.moved) clickAfterDragRef.current = true;
    dragRef.current = null;
  };
  /** A click that ends a drag is the drag's, not a click. */
  const isDragClick = useCallback(() => {
    if (!clickAfterDragRef.current) return false;
    clickAfterDragRef.current = false;
    return true;
  }, []);
  const goByPointer = useCallback(
    (key: string, fromKeyboard?: boolean) => {
      if (!fromKeyboard && isDragClick()) return;
      go(key, fromKeyboard);
    },
    [go, isDragClick],
  );

  const plain = (event: KeyboardEvent) => !event.altKey && !event.metaKey && !event.ctrlKey;
  // Escape anywhere in the lens steps back out; the arrows walk the circles, and only there.
  const onContainerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !plain(event)) return;
    event.preventDefault();
    up(true);
  };
  const onDrawingKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!plain(event) || level.length === 0) return;
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (keyboard + step + level.length) % level.length;
    setKeyboard(next);
    svgRef.current
      ?.querySelector<SVGGElement>(`[data-asks-node="${CSS.escape(level[next]!)}"]`)
      ?.focus();
  };
  const onKeyFocus = useCallback(
    (key: string | null) => {
      setKeyFocus(key);
      const index = key ? level.indexOf(key) : -1;
      if (index >= 0) setKeyboard(index);
    },
    [level],
  );

  const focusNode = focusKey === ROOT ? null : layout.byKey.get(focusKey);
  const focusTree = focusNode ? trees.get(focusNode.intent) : undefined;
  const status = drawFailed
    ? "The asks couldn't be drawn. All intents lists the same intents."
    : read.status === "loading"
      ? "Reading what each intent's asks are for…"
      : read.status === "failed"
        ? "Couldn't read what these intents' asks are for. Try again in a moment."
        : focusNode && level.length === 0
          ? focusTree
            ? "One thing, asked one way."
            : "Not grouped yet. Its asks fill in as they are read."
          : focusTree?.capped
            ? `Counts are of its newest ${n(focusTree.read)} asks.`
            : null;
  const spots = t ? labelSpots(layout, focusKey, t) : [];
  // Pointing names the circle a click would go to; the circle the reader is in, and those around it, are the trail's.
  const around = new Set([ROOT, ...trail]);
  const toward = (key: string | null) => {
    if (!key) return null;
    const next = stepToward(layout, focusKey, key);
    return around.has(next) ? null : next;
  };
  const card = picked ?? toward(hover?.key ?? null) ?? toward(keyFocus);
  const cardNode = card ? layout.byKey.get(card) : undefined;

  return (
    <div
      ref={containerRef}
      data-asks-pack={ready ? "ready" : "measuring"}
      data-focus-depth={focusNode?.depth ?? 0}
      // Focusable only by script: where focus lands when a level holds nothing to focus, so Escape still works.
      tabIndex={-1}
      className="relative h-[min(640px,72dvh)] min-h-[420px] overflow-hidden rounded-lg border border-line bg-app outline-none"
      onKeyDown={onContainerKeyDown}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 dot-grid opacity-45"
        style={t ? { backgroundPosition: `${4 + (t.x % 8)}px ${4 + (t.y % 8)}px` } : undefined}
      />
      <Trail
        layout={layout}
        trail={trail}
        model={model}
        trees={trees}
        onFocus={onFocus}
        onOpenIntent={onOpenIntent}
      />
      {!ready && !drawFailed ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <MapLoader label="Drawing the asks" />
        </div>
      ) : null}
      {ready ? (
        <svg
          ref={svgRef}
          width={size.width}
          height={size.height}
          role="group"
          aria-label={`Asks by intent: ${n(model.asks.length)} intents. Tab to a circle, Enter goes in, Escape comes back out; pinch or drag to look closer.`}
          className="absolute inset-0 block cursor-grab touch-none select-none active:cursor-grabbing"
          onKeyDown={onDrawingKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={(event) => {
            if (isDragClick()) return;
            if (event.target === event.currentTarget) up();
          }}
          onPointerLeave={() => setHover(null)}
        >
          <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
            {layout.nodes.map((node) => {
              const focusable = level.includes(node.key);
              return (
                <Circle
                  key={node.key}
                  node={node}
                  blob={node.kind === "intent" ? blobs.get(node.key) : undefined}
                  tone={tints.get(node.intent) ?? "neutral"}
                  lit={card === node.key}
                  faded={focusKey !== ROOT && node.key !== focusKey && !inside.has(node.key)}
                  tabIndex={focusable ? (level[keyboard] === node.key ? 0 : -1) : undefined}
                  title={
                    focusable
                      ? `${quote(nameOf(node, model, trees))}, ${asks(node.asks)}`
                      : undefined
                  }
                  onHover={setHover}
                  onKeyFocus={onKeyFocus}
                  onGo={goByPointer}
                />
              );
            })}
          </g>
        </svg>
      ) : null}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {spots.map((spot) => (
          <Label
            key={spot.key}
            spot={spot}
            node={layout.byKey.get(spot.key)!}
            name={nameOf(layout.byKey.get(spot.key)!, model, trees)}
            parent={layout.byKey.get(layout.byKey.get(spot.key)!.parent)}
          />
        ))}
      </div>
      {cardNode && t && size ? (
        <NodeCard
          node={cardNode}
          name={nameOf(cardNode, model, trees)}
          parent={layout.byKey.get(cardNode.parent)}
          parentName={
            layout.byKey.has(cardNode.parent)
              ? nameOf(layout.byKey.get(cardNode.parent)!, model, trees)
              : null
          }
          spot={hover && toward(hover.key) === card ? hover : centreOf(cardNode, t)}
          view={size}
          pinned={picked === card}
        />
      ) : null}
      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex flex-wrap items-end justify-between gap-2">
        <p className="text-xs text-fg-subtle" role="status">
          {status}
        </p>
        <Legend />
      </div>
    </div>
  );
}

/**
 * A label on the layer above the drawing, by its mode: a name and its count
 * at a circle's centre, over a soft dark glow with no edge; a name along the
 * top edge of a circle whose own circles carry theirs; or a count alone.
 * Every one wears a dark halo hugging its letters, so it reads over any tint.
 */
function Label({
  spot,
  node,
  name,
  parent,
}: {
  spot: AsksLabelSpot;
  node: AsksNode;
  name: AsksName;
  parent: AsksNode | undefined;
}) {
  const count =
    node.kind === "intent" || !parent || parent.of === 0
      ? asks(node.asks)
      : `${n(node.asks)} of ${n(parent.of)}`;
  const place = { left: spot.left, top: spot.top, width: spot.width };
  if (spot.mode === "count") {
    return (
      <div
        data-asks-label="count"
        className="absolute flex -translate-x-1/2 -translate-y-1/2 justify-center"
        style={place}
      >
        <span className={cn("text-xs text-fg-muted tabular-nums", HALO)}>{n(node.asks)}</span>
      </div>
    );
  }
  if (spot.mode === "edge") {
    return (
      <div
        data-asks-label="edge"
        className="absolute flex -translate-x-1/2 -translate-y-1/2 justify-center"
        style={place}
      >
        <span
          className={cn("max-w-full truncate font-medium text-fg-muted", HALO)}
          style={{ fontSize: spot.fontSize }}
        >
          {quote(name)}
        </span>
      </div>
    );
  }
  return (
    <div
      data-asks-label={spot.kind}
      className="absolute isolate flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 text-center"
      style={place}
    >
      {/* A soft dark glow behind the words, with no edge: the circles still show through, the name stands out. */}
      <span
        aria-hidden
        className="absolute inset-x-[12%] inset-y-[-10%] -z-10 rounded-full bg-app/55 blur-lg"
      />
      <span
        className={cn(
          "break-words",
          HALO,
          node.kind === "intent"
            ? "font-semibold text-fg"
            : node.kind === "rest"
              ? "text-fg-subtle"
              : "font-medium text-fg",
          // An ask as written is longer than a name: it gets a third line.
          spot.lines === 3 || name.quoted ? "line-clamp-3" : "line-clamp-2",
        )}
        style={{ fontSize: spot.fontSize, lineHeight: 1.25 }}
      >
        {quote(name)}
      </span>
      {node.kind !== "rest" ? (
        <span className={cn("text-xs whitespace-nowrap text-fg-muted tabular-nums", HALO)}>
          {count}
        </span>
      ) : null}
    </div>
  );
}

/** The view scaled by `scale` around a screen point, the point staying where it is. */
function scaledAround(
  t: ViewTransform,
  pinch: { scale: number; x: number; y: number },
): ViewTransform {
  return {
    k: t.k * pinch.scale,
    x: pinch.x - (pinch.x - t.x) * pinch.scale,
    y: pinch.y - (pinch.y - t.y) * pinch.scale,
  };
}

function centreOf(node: AsksNode, t: ViewTransform) {
  return { x: node.x * t.k + t.x, y: (node.y - node.r) * t.k + t.y };
}

/**
 * One circle: an intent's blob, or a circle inside one, with its ring (the
 * focus ring, and the lit one). Drawn again only when its own state changes,
 * never on a gliding frame or another circle's hover.
 */
const Circle = memo(function Circle({
  node,
  blob,
  tone,
  lit,
  faded,
  tabIndex,
  title,
  onHover,
  onKeyFocus,
  onGo,
}: {
  node: AsksNode;
  blob: string | undefined;
  tone: Tone;
  lit: boolean;
  faded: boolean;
  tabIndex: number | undefined;
  /** The accessible name, as text (people's asks): only the circles the keyboard walks carry one. */
  title: string | undefined;
  onHover: (hover: { key: string; x: number; y: number } | null) => void;
  onKeyFocus: (key: string | null) => void;
  onGo: (key: string, fromKeyboard?: boolean) => void;
}) {
  const fills = lit ? FILL_LIT : FILL;
  return (
    <g
      data-asks-node={node.key}
      data-kind={node.kind}
      role={tabIndex !== undefined ? "button" : undefined}
      tabIndex={tabIndex}
      className={cn(
        // The coral ring is the focus ring; no box around it.
        "cursor-pointer outline-none focus-visible:outline-none transition-opacity duration-160 motion-reduce:transition-none [&:focus-visible>.ring]:opacity-100",
        faded && "opacity-25",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onGo(node.key);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onGo(node.key, true);
        }
      }}
      onFocus={() => onKeyFocus(node.key)}
      onBlur={() => onKeyFocus(null)}
      onPointerMove={(event: PointerEvent<SVGGElement>) => {
        const box = (
          event.currentTarget.ownerSVGElement ?? event.currentTarget
        ).getBoundingClientRect();
        onHover({ key: node.key, x: event.clientX - box.left, y: event.clientY - box.top });
      }}
    >
      {title ? <title>{title}</title> : null}
      {node.kind === "intent" ? (
        <>
          <path
            d={blob}
            className={cn(
              "transition-[fill] duration-120 motion-reduce:transition-none",
              fills.intent[tone],
            )}
          />
          <path
            d={blob}
            vectorEffect="non-scaling-stroke"
            className={cn(RING, lit ? "opacity-100" : "opacity-0")}
          />
        </>
      ) : (
        <>
          {node.kind === "rest" ? (
            // Transparent, not none: a rest still takes the pointer.
            <circle
              cx={node.x}
              cy={node.y}
              r={node.r}
              vectorEffect="non-scaling-stroke"
              className="fill-transparent stroke-line-strong [stroke-dasharray:3_3] [stroke-width:1px]"
            />
          ) : (
            <circle
              cx={node.x}
              cy={node.y}
              r={node.r}
              className={cn(
                "transition-[fill] duration-120 motion-reduce:transition-none",
                (node.kind === "group" ? fills.group : fills.way)[tone],
              )}
            />
          )}
          <circle
            cx={node.x}
            cy={node.y}
            r={node.r}
            vectorEffect="non-scaling-stroke"
            className={cn(RING, lit ? "opacity-100" : "opacity-0")}
          />
        </>
      )}
    </g>
  );
});

/** Where the reader is: every intent, then the intent, then what they ask for; each step back is a button. */
function Trail({
  layout,
  trail,
  model,
  trees,
  onFocus,
  onOpenIntent,
}: {
  layout: AsksLayout;
  trail: readonly string[];
  model: IntentMapModel;
  trees: ReadonlyMap<string, IntentAsksTree>;
  onFocus: (key: string | null) => void;
  onOpenIntent: (topicId: string) => void;
}) {
  const intent = trail[0] ? layout.byKey.get(trail[0]) : undefined;
  const crumb =
    "inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 outline-none transition-colors duration-120 hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus";
  return (
    <nav
      aria-label="Where you are"
      className="absolute inset-x-0 top-0 z-10 flex h-11 items-center gap-1 px-2 text-ui"
    >
      <ol className="flex min-w-0 flex-1 items-center gap-1">
        <li className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => onFocus(null)}
            aria-current={trail.length === 0 ? "location" : undefined}
            className={cn(crumb, trail.length === 0 ? "text-fg" : "text-fg-muted")}
          >
            <MessageSquare aria-hidden strokeWidth={1.5} className="size-3.5 text-fg-subtle" />
            All intents
          </button>
        </li>
        {trail.map((key, index) => {
          const node = layout.byKey.get(key)!;
          const name = nameOf(node, model, trees);
          const last = index === trail.length - 1;
          return (
            <li key={key} className="flex min-w-0 items-center gap-1">
              <ChevronRight
                aria-hidden
                strokeWidth={1.5}
                className="size-3.5 shrink-0 text-fg-faint"
              />
              <button
                type="button"
                onClick={() => onFocus(key)}
                aria-current={last ? "location" : undefined}
                className={cn(crumb, last ? "text-fg" : "text-fg-muted")}
              >
                {node.kind === "intent" ? <NounIcon noun="intent" /> : null}
                <span className="truncate">{quote(name)}</span>
              </button>
            </li>
          );
        })}
        {trail.length === 0 ? (
          <li className="truncate pl-1 text-xs text-fg-subtle">
            Click an intent to see what its asks are for
          </li>
        ) : null}
      </ol>
      {intent ? (
        <button
          type="button"
          onClick={() => onOpenIntent(intent.intent)}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Open the intent
          <ArrowUpRight aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </nav>
  );
}

/** A circle's card: what it is, its asks, and its share of the circle around it; pinned for a picked one. */
function NodeCard({
  node,
  name,
  parent,
  parentName,
  spot,
  view,
  pinned,
}: {
  node: AsksNode;
  name: AsksName;
  parent: AsksNode | undefined;
  parentName: AsksName | null;
  spot: { x: number; y: number };
  view: { width: number; height: number };
  pinned: boolean;
}) {
  const left = Math.min(Math.max(8, spot.x + 14), view.width - CARD.width - 8);
  const top = Math.min(Math.max(TRAIL + 4, spot.y + 14), view.height - CARD.height - 8);
  const share = parent && parent.of > 0 ? node.asks / parent.of : null;
  const what =
    node.kind === "intent"
      ? "Intent"
      : node.kind === "group"
        ? "What they ask for"
        : node.kind === "way"
          ? "A way people ask it"
          : "Not listed";
  return (
    <div
      aria-hidden
      data-asks-card={pinned ? "pinned" : ""}
      className="pointer-events-none absolute z-sticky flex flex-col gap-1 rounded-lg border border-line bg-overlay p-2.5 text-xs text-fg-muted shadow-overlay"
      style={{ left, top, width: CARD.width }}
    >
      <p className="text-fg-subtle">{what}</p>
      <p className="line-clamp-4 text-ui break-words text-fg">{quote(name)}</p>
      <p className="tabular-nums">
        {asks(node.asks)}
        {share !== null && node.kind !== "intent" && parentName
          ? ` · ${pct(share)} of ${quote(parentName)}`
          : null}
      </p>
    </div>
  );
}

/** The three sizes of circle, and what each is. */
function Legend() {
  return (
    <p className="flex items-center gap-3 rounded-md bg-app/80 px-2 py-1 text-xs text-fg-subtle backdrop-blur-sm">
      <span className="inline-flex items-center gap-1.5">
        <svg aria-hidden viewBox="0 0 12 12" className="size-3">
          <circle cx="6" cy="6" r="5.5" className="fill-fg/[0.1]" />
        </svg>
        Intent
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg aria-hidden viewBox="0 0 12 12" className="size-3">
          <circle cx="6" cy="6" r="4" className="fill-fg/[0.18]" />
        </svg>
        What they ask for
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg aria-hidden viewBox="0 0 12 12" className="size-3">
          <circle cx="6" cy="6" r="2.5" className="fill-fg/[0.35]" />
        </svg>
        Ways people ask it
      </span>
      <span>Size is asks</span>
    </p>
  );
}
