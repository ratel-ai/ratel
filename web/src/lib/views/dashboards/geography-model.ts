import type { GeographyPlace } from "@/lib/synthesis/metrics/geography";

/** What the map widget draws: one of five steps of one color per place. Pure. */

export const MAP_STEPS = 5;

export interface MapModel {
  /** The step of each place with a value, from 1. A place that is not here has none. */
  stepOf: ReadonlyMap<string, number>;
  /** The top of the scale; it starts at 0. */
  max: number;
}

export function mapModel(places: readonly GeographyPlace[]): MapModel {
  const max = Math.max(0, ...places.map(({ value }) => value ?? 0));
  return {
    max,
    stepOf: new Map(
      places.flatMap(({ code, value }) =>
        value === null
          ? []
          : [[code, max === 0 ? 1 : Math.max(1, Math.ceil((value / max) * MAP_STEPS))]],
      ),
    ),
  };
}

/** The countries whose regions can be drawn. The others are a table. */
export function hasRegionMap(country: string): boolean {
  return country === "US";
}
