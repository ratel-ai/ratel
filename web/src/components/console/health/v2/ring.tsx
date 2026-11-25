import { cn } from "@ratel/design-system/cn";

/**
 * The parts Agent health's rings share (task completion's `StatusRing`, the
 * Hallucinations page's `GroupDonut`): the geometry in SVG units, each
 * slice's arc, the track under them and one arc. What a slice leads to and
 * what the middle says stay with each ring.
 */

export const RING_SIZE = 120;
const RADIUS = 46;
const WIDTH = 16;
/** A pointed-at slice is drawn wider. */
const POINTED_WIDTH = 20;
/** The gap between two slices. */
const GAP = 2;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Each slice's arc along the ring, in order: its length, less the gap to the next slice, and where it starts. */
export function ringArcs<T>(
  slices: readonly T[],
  shareOf: (slice: T) => number,
): Array<{ slice: T; length: number; offset: number }> {
  const gap = slices.length > 1 ? GAP : 0;
  let start = 0;
  return slices.map((slice) => {
    const arc = shareOf(slice) * RING_CIRCUMFERENCE;
    const out = { slice, length: Math.max(0.5, arc - gap), offset: start };
    start += arc;
    return out;
  });
}

/** The ring under the slices. */
export function RingTrack() {
  return (
    <circle
      cx={RING_SIZE / 2}
      cy={RING_SIZE / 2}
      r={RADIUS}
      fill="none"
      strokeWidth={WIDTH}
      className="stroke-raised"
    />
  );
}

/** One slice's arc: its paint is an SVG colour (`stroke`) or a class. */
export function RingArc({
  length,
  offset,
  pointed,
  stroke,
  className,
}: {
  length: number;
  offset: number;
  pointed: boolean;
  stroke?: string;
  className?: string;
}) {
  return (
    <circle
      cx={RING_SIZE / 2}
      cy={RING_SIZE / 2}
      r={RADIUS}
      fill="none"
      stroke={stroke}
      strokeWidth={pointed ? POINTED_WIDTH : WIDTH}
      strokeDasharray={`${length} ${RING_CIRCUMFERENCE - length}`}
      strokeDashoffset={-offset}
      className={cn(
        "transition-[opacity,stroke-width] duration-200 motion-reduce:transition-none",
        className,
      )}
    />
  );
}
