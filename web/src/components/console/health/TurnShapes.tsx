import type { CSSProperties } from "react";
import {
  LINK_PAINT,
  MARK_PAINT,
  ShapeLegend,
  type ShapeVocabulary,
} from "@/components/console/health/TurnShapesLegend";
import { TurnShapesLoop } from "@/components/console/health/TurnShapesLoop";
import {
  type AnyTurnShapeKind,
  OTEL_TURN_SHAPE_KINDS,
  TURN_SHAPE_KINDS,
  type TurnShapeView,
} from "@/lib/readings/trace-signals/view";
import {
  BEAT_MS,
  loopPercent,
  rowLoopDelayMs,
  SHAPE_LOOP,
  type StoryBeat,
  type StoryMotion,
  shapeLoop,
  shapeStory,
} from "@/lib/views/health/shape-story";
import {
  formatSharePercent,
  formatTurnCount,
  shapePictureLabel,
  sortShapes,
} from "@/lib/views/health/tiles";

export interface TurnShapesProps {
  /** Six shapes (five from OpenTelemetry), sorted by share descending. */
  shapes: readonly TurnShapeView[];
  /** Turns in the window, for the section's caption. */
  turns: number;
  /**
   * Which shapes these are: the SDK's, read around a search, or the
   * OpenTelemetry ones, which have no search and tell a chain of different
   * tools from the same tool again.
   */
  vocabulary?: ShapeVocabulary;
}

export type { ShapeVocabulary };

/* - Lattice ------------------------------------------------------------------ */

/**
 * Every pictogram sits on the same 4px lattice as the MCP flow diagram: a mark
 * is 5 by 5 cells, an arrow between two marks is 7 cells wide, and the widest
 * shape (three marks) sets one shared canvas so every row starts at the same x
 * and draws at the same scale.
 */
const U = 4;
const MARK = 5;
const LINK = 7;
const CANVAS_CELLS = MARK * 3 + LINK * 2;

/** The share bar is one quiet tone for every shape: the figure carries the reading. */
const BAR_TONE = "bg-cream-dim/45";

/** The section rises in right after the band. */
const SECTION_DELAY_MS = 480;
const BAR_DELAY_MS = 580;
const BAR_STAGGER_MS = 70;

/* - Motion ------------------------------------------------------------------- */

const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_SOFT = "cubic-bezier(0.4, 0, 0.2, 1)";

const REST = "var(--ts-rest, 1)";
const FLOOR = `calc(var(--ts-rest, 1) * ${SHAPE_LOOP.anchorFloor})`;

/** How a piece animates: its own arrival, or the anchor's dip and return. */
type LoopKind = "draw" | "fade" | "fill" | "pop" | "dip" | "dip-fill";

function loopKind(beat: StoryBeat): LoopKind {
  if (!beat.anchor) return beat.motion;
  return beat.motion === "fill" ? "dip-fill" : "dip";
}

/**
 * The keyframes of one kind of piece in one shape's loop. Every set opens on
 * the build (the piece not there yet, or the anchor dim), holds the finished
 * picture, fades, and ends where it opened, so each cycle flows into the next.
 */
function loopKeyframes(kind: LoopKind, shape: AnyTurnShapeKind): string {
  const { cycleMs, fadeAtMs } = shapeLoop(shape);
  const at = (ms: number) => loopPercent(ms, cycleMs);
  const build: number = SHAPE_LOOP.restBuildMs;
  const fade = at(fadeAtMs);
  const gone = at(fadeAtMs + SHAPE_LOOP.fadeOutMs);
  const goneAfter = at(fadeAtMs + SHAPE_LOOP.fadeOutMs + 1);
  const arrived = (motion: StoryMotion, from = build, share = 1) =>
    at(from + BEAT_MS[motion] * share);
  const hold = `animation-timing-function: ${EASE_SOFT}`;
  const name = `ts-${kind}-${shape}`;
  switch (kind) {
    case "draw":
    case "fade":
      return `@keyframes ${name} {
  0%, ${at(build)} { opacity: 0; animation-timing-function: ${kind === "draw" ? EASE_OUT : EASE_SOFT}; }
  ${arrived(kind)}, ${fade} { opacity: ${REST}; ${hold}; }
  ${gone}, 100% { opacity: 0; }
}`;
    case "fill":
    case "pop": {
      const from = kind === "fill" ? "scaleY(0)" : "scale(0.6)";
      const overshoot =
        kind === "pop"
          ? `\n  ${arrived("pop", build, 0.6)} { transform: scale(1.12); animation-timing-function: ${EASE_SOFT}; }`
          : "";
      return `@keyframes ${name} {
  0%, ${at(build - 1)} { opacity: 0; transform: ${from}; }
  ${at(build)} { opacity: ${REST}; transform: ${from}; animation-timing-function: ${EASE_OUT}; }${overshoot}
  ${arrived(kind)}, ${fade} { opacity: ${REST}; transform: none; ${hold}; }
  ${gone} { opacity: 0; transform: none; }
  ${goneAfter}, 100% { opacity: 0; transform: ${from}; }
}`;
    }
    case "dip":
      return `@keyframes ${name} {
  0% { opacity: ${FLOOR}; animation-timing-function: ${EASE_OUT}; }
  ${arrived("draw", 0)}, ${fade} { opacity: ${REST}; ${hold}; }
  ${gone}, 100% { opacity: ${FLOOR}; }
}`;
    case "dip-fill":
      return `@keyframes ${name} {
  0% { opacity: ${FLOOR}; transform: scaleY(0.5); animation-timing-function: ${EASE_OUT}; }
  ${arrived("fill", 0)}, ${fade} { opacity: ${REST}; transform: none; ${hold}; }
  ${gone}, 100% { opacity: ${FLOOR}; transform: scaleY(0.5); }
}`;
  }
}

/** The selector that picks a kind of piece out of a pictogram. */
const KIND_SELECTOR: Record<LoopKind, string> = {
  draw: ".ts-draw:not(.ts-anchor)",
  fade: ".ts-fade:not(.ts-anchor)",
  fill: ".ts-fill:not(.ts-anchor)",
  pop: ".ts-pop:not(.ts-anchor)",
  dip: ".ts-anchor:not(.ts-fill)",
  "dip-fill": ".ts-anchor.ts-fill",
};

/**
 * Each row tells its turn as a loop. Every piece runs its shape's cycle,
 * offset by its moment in the story (`--ts-d`) and its row's small stagger
 * (`--ts-row`), so the picture builds left to right, holds for a short beat,
 * fades as a wave in reading order and builds again, with no script and no
 * animation frame. Each shape's cycle is only as long as its story plus that
 * beat, so no row ever sits still for long.
 *
 * The first mark is the anchor (`.ts-anchor`): it only dims to a floor and is
 * already coming back while the rest of the picture is still fading, so no
 * frame of the loop is an empty pictogram. A tool anchor also sinks to half
 * height toward its base and grows back, the way a tool run fills.
 *
 * The loops run while `TurnShapesLoop` marks the list `running`: on screen and
 * in a visible tab, however the page was reached. Before that the list is
 * `idle` and every piece shows its settled look, the finished picture, which
 * is also what a hidden tab, a page without script and a reduced-motion reader
 * see. A piece waiting for its moment holds the opening frame (`backwards`
 * fill). Inlined with the component because a global stylesheet keyframe once
 * failed to reach the bundle.
 */
const MOTION = `[data-turn-shapes] [data-loop]:not([data-loop="idle"])`;

function shapeRules(shape: AnyTurnShapeKind): { rules: string; keyframes: string } {
  const kinds = [...new Set(shapeStory(shape).map(loopKind))];
  const picture = `${MOTION} [data-shape-pictogram="${shape}"]`;
  const rules = [
    `  ${picture} .ts-piece { animation-duration: ${shapeLoop(shape).cycleMs}ms; }`,
    ...kinds.map(
      (kind) => `  ${picture} ${KIND_SELECTOR[kind]} { animation-name: ts-${kind}-${shape}; }`,
    ),
  ].join("\n");
  return { rules, keyframes: kinds.map((kind) => loopKeyframes(kind, shape)).join("\n") };
}

/** The loop's stylesheet for one set of shapes; each vocabulary only ships its own keyframes. */
function loopStyles(kinds: readonly AnyTurnShapeKind[]): string {
  const rules = kinds.map(shapeRules);
  return `
[data-turn-shapes] .ts-piece { opacity: ${REST}; }
[data-turn-shapes] .ts-fill { transform-box: fill-box; transform-origin: 50% 100%; }
[data-turn-shapes] .ts-pop { transform-box: fill-box; transform-origin: 50% 50%; }
@media (prefers-reduced-motion: no-preference) {
  ${MOTION} .ts-piece {
    animation-timing-function: linear;
    animation-iteration-count: infinite;
    animation-fill-mode: backwards;
    animation-delay: calc(var(--ts-row, 0ms) + var(--ts-d, 0ms));
  }
${rules.map((each) => each.rules).join("\n")}
  ${MOTION}[data-loop="paused"] .ts-piece { animation-play-state: paused; }
}
${rules.map((each) => each.keyframes).join("\n")}
`;
}

const STYLES: Readonly<Record<ShapeVocabulary, string>> = {
  sdk: loopStyles(TURN_SHAPE_KINDS),
  otel: loopStyles(OTEL_TURN_SHAPE_KINDS),
};

type PieceStyle = CSSProperties & { "--ts-d"?: string; "--ts-rest"?: number };
type RowStyle = CSSProperties & { "--ts-row"?: string };

/* - Section ------------------------------------------------------------------ */

/**
 * The six shapes a turn can take, drawn rather than described, most common
 * first. Each row reads left to right: the shape's name and one plain
 * sentence, its pictogram right beside them at full scale, and the share as
 * one figure with the turn count under it. A single proportional bar under the
 * row grows in once.
 */
export function TurnShapes({ shapes, turns, vocabulary = "sdk" }: TurnShapesProps) {
  const sorted = sortShapes(shapes);
  return (
    <section
      aria-labelledby="turn-shapes-heading"
      data-turn-shapes="true"
      className="card-enter rounded-2xl border border-forest-300 bg-forest-600/40 p-4 sm:p-5"
      style={{ animationDelay: `${SECTION_DELAY_MS}ms` }}
    >
      <style dangerouslySetInnerHTML={{ __html: STYLES[vocabulary] }} />
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h2 id="turn-shapes-heading" className="font-display text-lg font-semibold text-cream">
            Turn shapes
          </h2>
          <p className="mt-1 text-sm text-warm-muted">
            How {formatTurnCount(turns)} went, most common first.
          </p>
        </div>
        <ShapeLegend vocabulary={vocabulary} />
      </div>
      <TurnShapesLoop className={`mt-3 ${LIST_GRID}`}>
        {sorted.map((shape, index) => (
          <ShapeRow key={shape.shape} shape={shape} index={index} />
        ))}
      </TurnShapesLoop>
    </section>
  );
}

/**
 * Rows lay out on one grid. On a phone: name and sentence beside the share,
 * then the pictogram with the proportional bar running beside it. From `sm`:
 * name, pictogram right beside it, the share at the far end, and the bar
 * under the whole row. From
 * `xl` the list folds into two columns of three, so a wide screen has no empty
 * lane.
 */
const ROW_GRID =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 border-t border-forest-300/50 py-3 first:border-t-0 sm:grid-cols-[minmax(0,16rem)_auto_minmax(0,1fr)_4.5rem] xl:grid-cols-[minmax(0,1fr)_auto_4.5rem] xl:[&:nth-child(4)]:border-t-0";
const LIST_GRID = "xl:grid xl:grid-flow-col xl:grid-cols-2 xl:grid-rows-3 xl:gap-x-10";

function ShapeRow({ shape, index }: { shape: TurnShapeView; index: number }) {
  const width = `${Math.max(0, Math.min(1, shape.share)) * 100}%`;
  return (
    <li data-turn-shape={shape.shape} className={ROW_GRID}>
      <div className="col-span-2 col-start-1 row-start-1 min-w-0 sm:col-span-1">
        <p className="text-sm font-medium text-cream">{shape.label}</p>
        <p className="mt-0.5 text-xs leading-5 text-warm-muted">{shape.description}</p>
      </div>
      <div className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1">
        <Pictogram shape={shape.shape} loopDelayMs={rowLoopDelayMs(index)} />
      </div>
      <div className="col-start-3 row-start-1 text-right sm:col-start-4 xl:col-start-3">
        <p className="font-display text-xl font-semibold leading-none tabular-nums text-cream">
          {formatSharePercent(shape.share)}
        </p>
        <p className="mt-1 font-mono text-[10px] tabular-nums text-warm-muted">
          {formatTurnCount(shape.count)}
        </p>
      </div>
      <div
        className="col-[2/4] row-start-2 h-[3px] sm:col-[1/-1]"
        aria-hidden
        data-shape-bar="true"
      >
        <div
          className={`meter-grow h-full rounded-full ${BAR_TONE}`}
          style={{
            width,
            minWidth: shape.share > 0 ? 3 : 0,
            animationDelay: `${BAR_DELAY_MS + index * BAR_STAGGER_MS}ms`,
          }}
        />
      </div>
    </li>
  );
}

/* - Pictograms --------------------------------------------------------------- */

/** Where a piece's slot starts on the canvas, in lattice cells. */
function slotX(beat: StoryBeat): number {
  const markX = beat.slot * (MARK + LINK);
  return beat.part === "link" ? markX - LINK : markX;
}

function Piece({ beat }: { beat: StoryBeat }) {
  const paint = beat.mark ? MARK_PAINT[beat.mark] : LINK_PAINT;
  const style: PieceStyle = { "--ts-d": `${beat.atMs}ms`, "--ts-rest": paint.rest };
  const x0 = slotX(beat);
  const className = `ts-piece ts-${beat.motion}${beat.anchor ? " ts-anchor" : ""}`;
  return (
    <g className={className} style={style} fill={paint.fill}>
      {beat.cells.map((cell) => (
        <rect
          key={`${cell.x}-${cell.y}`}
          x={(x0 + cell.x) * U}
          y={cell.y * U}
          width={cell.w * U}
          height={U}
        />
      ))}
    </g>
  );
}

/** The pictogram draws at 1.25x the lattice on a phone and 1.5x from `sm`. */
const PICTURE_SCALE = 1.25;
const PICTURE_CLASS = "block max-w-full sm:h-[30px] sm:w-[174px]";

/**
 * One shape on the lattice: marks joined by dotted arrows, each piece carrying
 * its moment in the story. At rest (and before its loop starts) the picture is
 * complete, so a screenshot, a hidden tab or a reduced-motion reader sees the
 * whole shape. The lattice stays in 4px cells in the viewBox; the picture is
 * drawn larger by its box, in whole screen pixels per cell.
 */
export function Pictogram({
  shape,
  loopDelayMs = 0,
}: {
  shape: AnyTurnShapeKind;
  loopDelayMs?: number;
}) {
  const rowStyle: RowStyle = { "--ts-row": `${loopDelayMs}ms` };
  const beats = shapeStory(shape);
  return (
    <svg
      role="img"
      aria-label={shapePictureLabel(shape)}
      data-shape-pictogram={shape}
      viewBox={`0 0 ${CANVAS_CELLS * U} ${MARK * U}`}
      width={CANVAS_CELLS * U * PICTURE_SCALE}
      height={MARK * U * PICTURE_SCALE}
      shapeRendering="crispEdges"
      className={PICTURE_CLASS}
      style={rowStyle}
    >
      {beats.map((beat) => (
        <Piece key={`${beat.part}-${beat.slot}-${beat.atMs}`} beat={beat} />
      ))}
    </svg>
  );
}
