import type { AnyTurnShapeKind } from "@/lib/readings/trace-signals/view";
import { type ShapeMark, shapeMarks } from "@/lib/views/health/tiles";

/**
 * The turn-shape pictograms as a short story on a loop, kept pure so the
 * component only draws and the timing can be tested.
 *
 * Every piece of a row runs the same cycle, shifted by its moment in the
 * story, and the cycle opens on the build, so a row starts telling its story
 * the moment the section comes into view. Each shape's cycle is only as long
 * as its own story plus a short hold, so no row sits still for long:
 *
 *   0 ms            the first mark builds up from a dim outline
 *   300 ms          every other piece arrives, left to right, piece by piece
 *   built           the finished picture holds for 900 ms
 *   built + 900     the picture fades as a wave in reading order
 *   ... + 360       it is gone, but the first mark only dims and never leaves
 *   ... + 120       the next cycle builds again
 *
 * The first mark is the anchor: it dims to a floor and starts back at once,
 * so no frame of the loop is ever an empty pictogram. Until a row's loop
 * starts (a hidden tab, no script, reduced motion, or a section not yet seen)
 * every piece sits at its final look, so the first paint is the finished
 * picture. Once started, a piece waiting for its moment holds the cycle's
 * opening frame: the anchor dim, the rest not yet there.
 */

/** A pictogram cell on the 4px lattice, or a horizontal run of cells. */
export interface StoryCell {
  x: number;
  y: number;
  w: number;
}

/**
 * How a piece arrives: a search ring draws in cell by cell, grey pieces fade
 * in gradually, a tool run fills from the bottom, an error pops at once.
 */
export type StoryMotion = "draw" | "fade" | "fill" | "pop";

/** One piece of a pictogram and the moment it starts to arrive. */
export interface StoryBeat {
  /** Which mark the piece belongs to; an arrow belongs to the mark it points at. */
  slot: number;
  /** True for the first mark's pieces: they dim and return, never vanish. */
  anchor: boolean;
  part: "mark" | "link";
  /** The mark's kind, or null for an arrow part. */
  mark: ShapeMark | null;
  motion: StoryMotion;
  /** Milliseconds from the start of the story. */
  atMs: number;
  /** Cells local to the piece's slot: a mark's 5 by 5 box, or an arrow's 7 by 5 gap. */
  cells: readonly StoryCell[];
}

/** The marks as pixel maps on a 5 by 5 box: ring, square, cross, dotted slot, hollow square. */
export const MARK_ROWS: Readonly<Record<ShapeMark, readonly string[]>> = {
  search: [".XXX.", "X...X", "X...X", "X...X", ".XXX."],
  tool: ["XXXXX", "XXXXX", "XXXXX", "XXXXX", "XXXXX"],
  error: ["X...X", ".X.X.", "..X..", ".X.X.", "X...X"],
  nothing: ["X.X.X", ".....", "X...X", ".....", "X.X.X"],
  next: ["XXXXX", "X...X", "X...X", "X...X", "XXXXX"],
};

/** The arrow between two marks: two dots along the middle row, then a chevron. */
export const LINK_PARTS: readonly (readonly StoryCell[])[] = [
  [{ x: 1, y: 2, w: 1 }],
  [{ x: 3, y: 2, w: 1 }],
  [
    { x: 4, y: 1, w: 1 },
    { x: 5, y: 2, w: 1 },
    { x: 4, y: 3, w: 1 },
  ],
];

/** Timing of the story itself, all in milliseconds from its start. */
export const STORY_TIMING = {
  /** From one mark starting to the next one starting. */
  markGapMs: 480,
  /** From a mark starting to its outgoing arrow's first dot. */
  linkLeadMs: 240,
  /** Between the dots of an arrow. */
  linkStepMs: 70,
  /** The extra pause before a tool that runs again. */
  repeatLagMs: 160,
  /** Between the cells of a search ring as it draws. */
  ringStepMs: 40,
  /** Between the dots of an empty slot as it opens. */
  dotStepMs: 70,
} as const;

/** How long each kind of piece takes to arrive once its moment comes. */
export const BEAT_MS: Readonly<Record<StoryMotion, number>> = {
  draw: 220,
  fade: 320,
  fill: 520,
  pop: 200,
};

/** The loop around the story, shared by every row. Times are from a piece's own moment. */
export const SHAPE_LOOP = {
  /** Every piece but the anchor starts arriving this long after its moment. */
  restBuildMs: 300,
  /** The finished picture holds this long before it fades: a short beat, never a stall. */
  holdMs: 900,
  /** A piece fades out over this long; the anchor only to its floor. */
  fadeOutMs: 360,
  /** The anchor rests at its floor this long before the next build. */
  dimMs: 120,
  /** The anchor's lowest opacity, as a share of its settled opacity. */
  anchorFloor: 0.35,
  /** Rows start this far apart once the section is in view, so none pulse together. */
  rowStaggerMs: 100,
} as const;

/** One shape's loop: when its finished picture starts to fade, and how long a cycle runs. */
export interface ShapeLoop {
  fadeAtMs: number;
  cycleMs: number;
}

/** The motion each mark arrives with. */
const MARK_MOTION: Readonly<Record<ShapeMark, StoryMotion>> = {
  search: "draw",
  tool: "fill",
  error: "pop",
  nothing: "fade",
  next: "fill",
};

/** Horizontal runs of set cells, so a solid mark is a handful of rects, not 25. */
export function pixelRuns(rows: readonly string[]): StoryCell[] {
  return rows.flatMap((row, y) =>
    [...row.matchAll(/X+/g)].map((match) => ({ x: match.index ?? 0, y, w: match[0].length })),
  );
}

/**
 * The set cells of a mark in clockwise order from twelve o'clock, the order a
 * pen would draw a ring or a hand would tick round an empty slot.
 */
export function clockwiseCells(rows: readonly string[]): StoryCell[] {
  const centre = (rows.length - 1) / 2;
  const angle = (cell: StoryCell) => {
    const turn = Math.atan2(cell.x - centre, centre - cell.y);
    return turn < 0 ? turn + 2 * Math.PI : turn;
  };
  const cells = rows.flatMap((row, y) =>
    [...row].flatMap((char, x) => (char === "X" ? [{ x, y, w: 1 }] : [])),
  );
  return [...cells].sort((a, b) => angle(a) - angle(b));
}

/** A mark's pieces: one per cell when it arrives in sequence, else one piece. */
function markBeats(mark: ShapeMark, slot: number, atMs: number): StoryBeat[] {
  const motion = MARK_MOTION[mark];
  const base = { slot, anchor: slot === 0, part: "mark" as const, mark, motion };
  if (mark === "search" || mark === "nothing") {
    const step = mark === "search" ? STORY_TIMING.ringStepMs : STORY_TIMING.dotStepMs;
    return clockwiseCells(MARK_ROWS[mark]).map((cell, index) => ({
      ...base,
      atMs: atMs + index * step,
      cells: [cell],
    }));
  }
  return [{ ...base, atMs, cells: pixelRuns(MARK_ROWS[mark]) }];
}

/** An arrow's pieces, dot by dot, leaving the previous mark. */
function linkBeats(slot: number, fromMs: number): StoryBeat[] {
  return LINK_PARTS.map((cells, index) => ({
    slot,
    anchor: false,
    part: "link" as const,
    mark: null,
    motion: "fade" as const,
    atMs: fromMs + STORY_TIMING.linkLeadMs + index * STORY_TIMING.linkStepMs,
    cells,
  }));
}

/**
 * A shape's story in reading order: each mark after the first is preceded by
 * its arrow, a tool that runs again lags a beat behind, and nothing is timed
 * before the piece to its left.
 */
export function shapeStory(shape: AnyTurnShapeKind): StoryBeat[] {
  const marks = shapeMarks(shape);
  const starts = marks.reduce<number[]>((acc, mark, slot) => {
    if (slot === 0) return [0];
    const again = mark === "tool" && marks.slice(0, slot).includes("tool");
    const at = acc[slot - 1] + STORY_TIMING.markGapMs + (again ? STORY_TIMING.repeatLagMs : 0);
    return [...acc, at];
  }, []);
  return marks.flatMap((mark, slot) => [
    ...(slot === 0 ? [] : linkBeats(slot, starts[slot - 1])),
    ...markBeats(mark, slot, starts[slot]),
  ]);
}

/** When the story's last piece starts to arrive. */
export function storyLastStartMs(shape: AnyTurnShapeKind): number {
  return Math.max(...shapeStory(shape).map((beat) => beat.atMs));
}

/** When the story's last piece has fully arrived. */
export function storyEndMs(shape: AnyTurnShapeKind): number {
  return Math.max(...shapeStory(shape).map((beat) => beat.atMs + BEAT_MS[beat.motion]));
}

/** When the finished picture is complete: every piece has arrived, anchor at once, the rest after the lag. */
export function storyBuiltMs(shape: AnyTurnShapeKind): number {
  return Math.max(
    ...shapeStory(shape).map(
      (beat) => beat.atMs + (beat.anchor ? 0 : SHAPE_LOOP.restBuildMs) + BEAT_MS[beat.motion],
    ),
  );
}

/**
 * A shape's own loop: build, hold briefly, fade, dim, and build again. A short
 * story (a single tool run) cycles in about two seconds, the longest in about
 * three and a half, and every one holds its finished picture for the same
 * short beat.
 */
export function shapeLoop(shape: AnyTurnShapeKind): ShapeLoop {
  const fadeAtMs = storyBuiltMs(shape) + SHAPE_LOOP.holdMs;
  return { fadeAtMs, cycleMs: fadeAtMs + SHAPE_LOOP.fadeOutMs + SHAPE_LOOP.dimMs };
}

/** When row `index` (sorted order) starts its first build, from the moment the section is seen. */
export function rowLoopDelayMs(index: number): number {
  return index * SHAPE_LOOP.rowStaggerMs;
}

/** A moment in a loop of `cycleMs` as a keyframe offset, e.g. 1620 ms of 5400 is "30%". */
export function loopPercent(ms: number, cycleMs: number): string {
  const percent = Math.round((ms / cycleMs) * 100_000) / 1000;
  return `${percent}%`;
}

/**
 * How much of a piece shows at loop time `tMs` (from its row's start), as a
 * share of its settled opacity. A linear model of the keyframes the component
 * draws, used to prove the loop never shows an empty picture. Before its
 * moment a piece holds the opening frame (the animation fills backwards): the
 * anchor at its floor, any other piece not yet there. After that an ordinary
 * piece arrives, holds, fades and stays gone until the next build; the anchor
 * never drops below its floor. A fill or a pop grows in rather than fading,
 * which the model reads the same way: from nothing to whole over its beat.
 */
export function pieceShowingAt(beat: StoryBeat, tMs: number, loop: ShapeLoop): number {
  const { cycleMs, fadeAtMs } = loop;
  const { restBuildMs, fadeOutMs, anchorFloor } = SHAPE_LOOP;
  const floor = beat.anchor ? anchorFloor : 0;
  if (tMs < beat.atMs) return floor;
  const at = (tMs - beat.atMs) % cycleMs;
  const build = beat.anchor ? 0 : restBuildMs;
  const arrive = BEAT_MS[beat.motion];
  if (at < build) return floor;
  if (at < build + arrive) return floor + (1 - floor) * ((at - build) / arrive);
  if (at < fadeAtMs) return 1;
  if (at < fadeAtMs + fadeOutMs) return 1 - (1 - floor) * ((at - fadeAtMs) / fadeOutMs);
  return floor;
}

/** The most of any piece showing at loop time `tMs`; zero would be an empty pictogram. */
export function pictureShowingAt(shape: AnyTurnShapeKind, tMs: number): number {
  const loop = shapeLoop(shape);
  return Math.max(...shapeStory(shape).map((beat) => pieceShowingAt(beat, tMs, loop)));
}
