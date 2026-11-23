/**
 * The colors of the satisfaction graph (pure). A value has one color: red
 * when people were unsatisfied, yellow when mixed, green when satisfied,
 * blended smoothly in between. The stops sit around the mood bands the
 * satisfaction faces use (below 40%, 40 to 70%, from 70%).
 */
export const MOOD_STOPS: ReadonlyArray<{ at: number; color: string; hex: string }> = [
  { at: 0, color: "var(--ds-danger)", hex: "#f75b6b" },
  { at: 0.3, color: "var(--ds-danger)", hex: "#f75b6b" },
  { at: 0.55, color: "var(--ds-warning)", hex: "#edb345" },
  { at: 0.8, color: "var(--ds-success)", hex: "#5ac576" },
  { at: 1, color: "var(--ds-success)", hex: "#5ac576" },
];

const channel = (hex: string, i: number): number =>
  Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);

export function moodColor(value: number): string {
  const upper = MOOD_STOPS.findIndex((stop) => stop.at >= value);
  const high = MOOD_STOPS[upper < 0 ? MOOD_STOPS.length - 1 : upper];
  const low = MOOD_STOPS[upper - 1];
  if (!high) return "";
  if (!low || low.hex === high.hex) return high.hex;
  const t = (value - low.at) / (high.at - low.at);
  const mixed = [0, 1, 2].map((i) =>
    Math.round(channel(low.hex, i) + (channel(high.hex, i) - channel(low.hex, i)) * t),
  );
  return `rgb(${mixed.join(", ")})`;
}

/** Stops between two days, so a change passes through the colors between them (red to yellow to green). */
const BETWEEN = 4;

export interface DayStop {
  /** Along the days: 0 the first, 1 the last. */
  offset: number;
  color: string;
}

/**
 * The graph's color along the days: the whole height over a day is that
 * day's color. A day without an answer has no stop.
 */
export function dayStops(values: readonly (number | null)[]): DayStop[] {
  const last = Math.max(1, values.length - 1);
  return values.flatMap((value, at) => {
    if (value === null) return [];
    const stops: DayStop[] = [{ offset: at / last, color: moodColor(value) }];
    const next = values[at + 1];
    if (next === null || next === undefined) return stops;
    for (let i = 1; i < BETWEEN; i++) {
      const t = i / BETWEEN;
      stops.push({ offset: (at + t) / last, color: moodColor(value + (next - value) * t) });
    }
    return stops;
  });
}
