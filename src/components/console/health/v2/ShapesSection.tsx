import { cn } from "@ratel/design-system/cn";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { Section } from "@ratel/design-system/section";
import { Tooltip } from "@ratel/design-system/tooltip";
import { Shapes } from "lucide-react";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import type { AnyTurnShapeKind, TurnShapeView } from "@/lib/readings/trace-signals/view";
import { LINK_PARTS, MARK_ROWS, pixelRuns } from "@/lib/views/health/shape-story";
import {
  formatSharePercent,
  formatTurnCount,
  type ShapeMark,
  shapeMarks,
  shapePictureLabel,
  sortShapes,
} from "@/lib/views/health/tiles";

/**
 * Turn shapes: how the window's turns went, most common first, each drawn
 * as a small pixel picture (the brand's lattice, DESIGN.md Brand) beside
 * its name and its share. The sentence a shape stands for is a hover away
 * (and read aloud with it). Still pictures: no idle motion.
 */

/** A mark is 5 by 5 lattice cells, the arrow between two marks 7 wide; a cell is 4 px. */
const U = 4;
const MARK = 5;
const LINK = 7;
const WIDEST = MARK * 3 + LINK * 2;

/** Shape carries the meaning; the color repeats it (an error is red, nothing faint). */
const MARK_TONE: Readonly<Record<ShapeMark, string>> = {
  search: "text-fg-muted",
  tool: "text-fg",
  error: "text-danger",
  nothing: "text-fg-faint",
  next: "text-fg",
};

const LEGEND: Readonly<Record<"sdk" | "otel", readonly { mark: ShapeMark; label: string }[]>> = {
  sdk: [
    { mark: "search", label: "Search" },
    { mark: "tool", label: "Tool run" },
    { mark: "error", label: "Error" },
    { mark: "nothing", label: "Nothing run" },
  ],
  otel: [
    { mark: "tool", label: "Tool run" },
    { mark: "next", label: "Another tool" },
    { mark: "error", label: "Error" },
  ],
};

function Mark({ mark, x, unit = U }: { mark: ShapeMark; x: number; unit?: number }) {
  return (
    <g className={MARK_TONE[mark]} fill="currentColor">
      {pixelRuns(MARK_ROWS[mark]).map((run) => (
        <rect
          key={`${run.x}-${run.y}`}
          x={(x + run.x) * unit}
          y={run.y * unit}
          width={run.w * unit}
          height={unit}
        />
      ))}
    </g>
  );
}

function Arrow({ x }: { x: number }) {
  return (
    <g className="text-fg-faint" fill="currentColor">
      {LINK_PARTS.flat().map((cell) => (
        <rect
          key={`${cell.x}-${cell.y}`}
          x={(x + cell.x) * U}
          y={cell.y * U}
          width={cell.w * U}
          height={U}
        />
      ))}
    </g>
  );
}

/** One shape on the lattice: marks joined by dotted arrows, every row at the same scale. */
export function ShapePictogram({
  shape,
  className,
}: {
  shape: AnyTurnShapeKind;
  className?: string;
}) {
  const marks = shapeMarks(shape);
  return (
    <svg
      role="img"
      aria-label={shapePictureLabel(shape)}
      data-shape-pictogram={shape}
      viewBox={`0 0 ${WIDEST * U} ${MARK * U}`}
      width={WIDEST * U * 1.25}
      height={MARK * U * 1.25}
      shapeRendering="crispEdges"
      className={cn("block max-w-full shrink-0", className)}
    >
      {marks.map((mark, index) => {
        const x = index * (MARK + LINK);
        return (
          <g key={index}>
            {index > 0 ? <Arrow x={x - LINK} /> : null}
            <Mark mark={mark} x={x} />
          </g>
        );
      })}
    </svg>
  );
}

function Legend({ vocabulary }: { vocabulary: "sdk" | "otel" }) {
  return (
    <ul aria-label="Key" className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {LEGEND[vocabulary].map(({ mark, label }) => (
        <li key={mark} className="flex items-center gap-1.5 text-xs text-fg-subtle">
          <svg
            aria-hidden
            viewBox={`0 0 ${MARK * 2} ${MARK * 2}`}
            width={MARK * 2}
            height={MARK * 2}
            shapeRendering="crispEdges"
          >
            <Mark mark={mark} x={0} unit={2} />
          </svg>
          {label}
        </li>
      ))}
    </ul>
  );
}

export function ShapesSection({
  shapes,
  turns,
  vocabulary,
}: {
  shapes: readonly TurnShapeView[];
  turns: number;
  vocabulary: "sdk" | "otel";
}) {
  const sorted = sortShapes(shapes);
  if (sorted.length === 0) return null;
  return (
    <Section
      title={<NounTitle icon={Shapes}>Turn shapes</NounTitle>}
      description={`${formatTurnCount(turns)}, most common first.`}
      actions={<Legend vocabulary={vocabulary} />}
    >
      <ul
        className="grid grid-cols-1 gap-x-8 sm:grid-cols-2 xl:grid-cols-3"
        data-turn-shapes={sorted.length}
      >
        {sorted.map((shape) => (
          <li
            key={shape.shape}
            data-turn-shape={shape.shape}
            className="flex items-center gap-3 border-b border-line py-2.5"
          >
            <div className="flex w-24 min-w-0 shrink-0 flex-col gap-1.5">
              <Tooltip content={shape.description}>
                <p className="truncate text-ui font-medium text-fg">
                  {shape.label}
                  <span className="sr-only">: {shape.description}</span>
                </p>
              </Tooltip>
              <DotMeter
                value={shape.share}
                cells={12}
                tone="neutral"
                label={`${formatSharePercent(shape.share)} of turns`}
              />
            </div>
            <div className="flex min-w-0 flex-1">
              <ShapePictogram shape={shape.shape} className="max-sm:h-auto max-sm:w-24" />
            </div>
            <div className="flex shrink-0 flex-col items-end">
              <p className="text-sm font-semibold text-fg tabular-nums">
                {formatSharePercent(shape.share)}
              </p>
              <p className="text-xs text-fg-subtle tabular-nums">{formatTurnCount(shape.count)}</p>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
