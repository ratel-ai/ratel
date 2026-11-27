import { geoBounds, geoContains } from "d3-geo";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import { countryOfShape, type GeoCodes, regionOfShape } from "@/lib/ingest/geo/codes";

/**
 * Coordinates to a place, on the bundled boundaries: `world-atlas` (Natural Earth, public domain)
 * for countries, `us-atlas` (US Census Bureau, public domain) for the states of the United States.
 */

export type ReverseLookup = (latitude: number, longitude: number) => GeoCodes | null;

interface Shape {
  code: string;
  geometry: GeoJSON.Feature;
  /** West, south, east, north: most shapes are ruled out by it. */
  bounds: [[number, number], [number, number]];
}

/** The point itself, then around it, in degrees: a simplified coast leaves a harbor in the sea. */
const NEARBY: readonly [number, number][] = [
  [0, 0],
  ...[0.05, 0.15].flatMap((step): [number, number][] => [
    [0, step],
    [0, -step],
    [step, 0],
    [-step, 0],
    [step, step],
    [step, -step],
    [-step, step],
    [-step, -step],
  ]),
];

let loaded: Promise<ReverseLookup> | undefined;

/** Loaded on the first trace that carries coordinates. */
export function loadReverseLookup(): Promise<ReverseLookup> {
  loaded ??= load();
  return loaded;
}

async function load(): Promise<ReverseLookup> {
  const [world, states] = await Promise.all([
    import("world-atlas/countries-50m.json"),
    import("us-atlas/states-10m.json"),
  ]);
  const countries = shapes(
    world.default as unknown as Topology,
    "countries",
    ({ id, properties }) => countryOfShape(id, properties?.name),
  );
  const regions = shapes(states.default as unknown as Topology, "states", ({ id }) =>
    regionOfShape(id),
  );
  return (latitude, longitude) => {
    if (!(Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180)) return null;
    for (const [north, east] of NEARBY) {
      const point: [number, number] = [longitude + east, latitude + north];
      // The states are drawn finer than the countries.
      const region = at(regions, point);
      if (region) return { country: "US", region };
      const country = at(countries, point);
      if (country) return { country, region: null };
    }
    return null;
  };
}

function shapes(
  topology: Topology,
  name: string,
  codeOf: (shape: GeoJSON.Feature) => string | null,
): Shape[] {
  const collection = feature(topology, topology.objects[name] as GeometryCollection);
  return collection.features.flatMap((geometry) => {
    const code = codeOf(geometry);
    return code ? [{ code, geometry, bounds: geoBounds(geometry) }] : [];
  });
}

function at(candidates: readonly Shape[], point: [number, number]): string | null {
  const found = candidates.find(
    ({ geometry, bounds }) => near(bounds, point) && geoContains(geometry, point),
  );
  return found?.code ?? null;
}

function near([[west, south], [east, north]]: Shape["bounds"], [lon, lat]: [number, number]) {
  if (lat < south || lat > north) return false;
  // A shape over the antimeridian has its west past its east.
  return west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
}
