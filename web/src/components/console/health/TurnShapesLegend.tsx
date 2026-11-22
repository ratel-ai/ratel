import { MARK_ROWS, pixelRuns } from "@/lib/views/health/shape-story";
import type { ShapeMark } from "@/lib/views/health/tiles";

/**
 * Which shapes a list draws: the SDK's, read around a search, or the
 * OpenTelemetry ones, which have no search and tell a chain of different
 * tools from the same tool again.
 */
export type ShapeVocabulary = "sdk" | "otel";

const CREAM = "var(--color-cream)";
const DIM = "var(--color-cream-dim)";
const CORAL = "var(--color-coral)";
const MUTED = "var(--color-warm-muted)";

/** A mark is 5 by 5 lattice cells. */
const MARK = 5;

/**
 * How each mark is painted: a search is a ring, a tool run a solid square, an
 * error a coral cross, "ran nothing" a dotted empty slot, and another tool a
 * hollow square. Shape carries the meaning; colour only repeats it. `rest` is
 * the mark's settled opacity.
 */
export const MARK_PAINT: Record<ShapeMark, { fill: string; rest: number }> = {
  search: { fill: DIM, rest: 1 },
  tool: { fill: CREAM, rest: 0.92 },
  error: { fill: CORAL, rest: 1 },
  nothing: { fill: MUTED, rest: 0.7 },
  next: { fill: CREAM, rest: 0.92 },
};
export const LINK_PAINT = { fill: MUTED, rest: 0.55 };

function MarkCells({ mark, unit }: { mark: ShapeMark; unit: number }) {
  const { fill, rest } = MARK_PAINT[mark];
  return (
    <g fill={fill} opacity={rest}>
      {pixelRuns(MARK_ROWS[mark]).map((run) => (
        <rect
          key={`${run.x}-${run.y}`}
          x={run.x * unit}
          y={run.y * unit}
          width={run.w * unit}
          height={unit}
        />
      ))}
    </g>
  );
}

const LEGEND: Readonly<Record<ShapeVocabulary, readonly { mark: ShapeMark; label: string }[]>> = {
  sdk: [
    { mark: "search", label: "search" },
    { mark: "tool", label: "tool run" },
    { mark: "error", label: "error" },
    { mark: "nothing", label: "nothing run" },
  ],
  otel: [
    { mark: "tool", label: "tool run" },
    { mark: "next", label: "another tool" },
    { mark: "error", label: "error" },
  ],
};

/** A small key for the marks, drawn at half scale on the same lattice. It stays still. */
export function ShapeLegend({ vocabulary }: { vocabulary: ShapeVocabulary }) {
  const unit = 2;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5" aria-label="Key">
      {LEGEND[vocabulary].map(({ mark, label }) => (
        <li key={mark} className="flex items-center gap-1.5">
          <svg
            viewBox={`0 0 ${MARK * unit} ${MARK * unit}`}
            width={MARK * unit}
            height={MARK * unit}
            shapeRendering="crispEdges"
            aria-hidden
          >
            <MarkCells mark={mark} unit={unit} />
          </svg>
          <span className="eyebrow">{label}</span>
        </li>
      ))}
    </ul>
  );
}
