"use client";

import { Tooltip } from "@ratel/design-system/tooltip";
import { geoEqualEarth, geoPath } from "d3-geo";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import atlas from "world-atlas/countries-110m.json";
import { track } from "@/lib/platform/track-client";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import { featureAlpha2 } from "@/lib/views/clients/country-codes";
import {
  CALL_BUCKETS,
  type CountryCalls,
  callBucket,
  countryCalls,
} from "@/lib/views/clients/country-map-model";
import type { CountryRow } from "@/lib/views/clients/queries";
import { countryLabel } from "./labels";

/**
 * The Clients tab's caller map (RC-1058): the world, each country colored by
 * the calls from it, on one sequential blue (DESIGN.md, Data visualization).
 * A country with no calls stays neutral. Hover names the country with its
 * calls and sessions; a click opens Traces filtered to it. The country table
 * under the map stays the accessible view, with the unknown-country row.
 *
 * It loads through `next/dynamic` from the Clients tab only: the world
 * geometry (world-atlas, 110m) ships in this chunk and nowhere else.
 */

const WIDTH = 960;
const HEIGHT = 440;
/** Antarctica takes a fifth of the frame and never has a caller. */
const ANTARCTICA = "010";

/** Bucket 0 is neutral land; 1 to CALL_BUCKETS step one hue from light to full. */
const BUCKET_FILL: readonly string[] = [
  "fill-line",
  "fill-chart-1/30",
  "fill-chart-1/50",
  "fill-chart-1/75",
  "fill-chart-1",
];
const BUCKET_SWATCH: readonly string[] = [
  "bg-line",
  "bg-chart-1/30",
  "bg-chart-1/50",
  "bg-chart-1/75",
  "bg-chart-1",
];

type CountryFeature = Feature<Geometry, { name: string }> & { id?: string | number };

interface Shape {
  key: string;
  d: string;
  code: string | null;
}

/** Projected once, when this chunk loads. */
const WORLD: readonly Shape[] = drawWorld();

export interface CountryMapProps {
  countries: readonly CountryRow[];
  /** Where a country opens: Traces filtered to it, with the tab's filters. */
  hrefFor: (code: string) => string;
  /** For the click event: the tab shows one server's callers. */
  serverFiltered: boolean;
}

export function CountryMap({ countries, hrefFor, serverFiltered }: CountryMapProps) {
  const router = useRouter();
  const byCode = useMemo(() => countryCalls(countries), [countries]);
  const maxCalls = useMemo(
    () => Math.max(0, ...[...byCode.values()].map((row) => row.calls)),
    [byCode],
  );

  return (
    <figure className="flex flex-col gap-3 rounded-lg border border-line bg-raised p-3">
      {/* biome-ignore lint/a11y/useSemanticElements: an svg cannot be a fieldset; the group names its country shapes */}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="group"
        aria-label="Map of calls by country"
      >
        {WORLD.map((shape) => {
          const row = shape.code ? byCode.get(shape.code) : undefined;
          const bucket = row ? callBucket(row.calls, maxCalls) : 0;
          const path = (
            <path d={shape.d} className={`${BUCKET_FILL[bucket]} stroke-raised stroke-[0.5]`} />
          );
          if (!row || bucket === 0) return <g key={shape.key}>{path}</g>;
          const href = hrefFor(row.code);
          return (
            <Tooltip key={shape.key} content={<CountryTip row={row} />}>
              <a
                href={href}
                aria-label={`${countryLabel(row.code)}: ${callsAndSessions(row)}`}
                className="cursor-pointer outline-none [&>path]:transition-[stroke] hover:[&>path]:stroke-fg focus-visible:[&>path]:stroke-focus focus-visible:[&>path]:stroke-2"
                onClick={(event) => {
                  track("client_country_clicked", {
                    country: row.code,
                    calls: row.calls,
                    server_filtered: serverFiltered,
                  });
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                    return;
                  event.preventDefault();
                  router.push(href);
                }}
              >
                {path}
              </a>
            </Tooltip>
          );
        })}
      </svg>
      <Legend maxCalls={maxCalls} />
    </figure>
  );
}

function CountryTip({ row }: { row: CountryCalls }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium text-fg">{countryLabel(row.code)}</span>
      <span className="tabular-nums text-fg-muted">{callsAndSessions(row, " · ")}</span>
    </span>
  );
}

/** "12 calls, 1 session": the counts in words, singular for one. */
function callsAndSessions(row: CountryCalls, separator = ", "): string {
  const count = (n: number, noun: string) => `${formatInteger(n)} ${noun}${n === 1 ? "" : "s"}`;
  return `${count(row.calls, "call")}${separator}${count(row.sessions, "session")}`;
}

/** One swatch for no calls, then the ramp from one call to the busiest country. */
function Legend({ maxCalls }: { maxCalls: number }) {
  const steps = Array.from({ length: CALL_BUCKETS }, (_, index) => index + 1);
  return (
    <figcaption className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-fg-subtle">
      <span className="flex items-center gap-2">
        <span className={`size-3 rounded-sm ${BUCKET_SWATCH[0]}`} aria-hidden />
        No calls
      </span>
      {maxCalls > 0 ? (
        <span className="flex items-center gap-2">
          <span className="tabular-nums">1</span>
          <span className="flex gap-0.5" aria-hidden>
            {steps.map((step) => (
              <span
                key={step}
                className={`h-3 w-6 first:rounded-l-sm last:rounded-r-sm ${BUCKET_SWATCH[step]}`}
              />
            ))}
          </span>
          <span className="tabular-nums">{formatInteger(maxCalls)} calls</span>
        </span>
      ) : null}
    </figcaption>
  );
}

/** The countries as SVG paths: the projection fits the frame. */
function drawWorld(): Shape[] {
  const topology = atlas as unknown as Topology<{
    countries: GeometryCollection<{ name: string }>;
  }>;
  const world = feature(topology, topology.objects.countries) as FeatureCollection<
    Geometry,
    { name: string }
  >;
  const features = (world.features as CountryFeature[]).filter(
    (country) => country.id !== ANTARCTICA,
  );
  const projection = geoEqualEarth().fitSize([WIDTH, HEIGHT], {
    type: "FeatureCollection",
    features,
  });
  const path = geoPath(projection);
  return features.map((country, index) => ({
    key: String(country.id ?? `${country.properties.name}-${index}`),
    d: path(country) ?? "",
    code: featureAlpha2(country.id, country.properties.name),
  }));
}
