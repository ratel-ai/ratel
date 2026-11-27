"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { DataTable } from "@ratel/design-system/data-table";
import { EmptyState } from "@ratel/design-system/states";
import { MapPin } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { GeographyQuery } from "@/lib/contracts/query";
import { countryOfShape, placeName, regionOfShape } from "@/lib/ingest/geo/codes";
import type { MetricUnit } from "@/lib/synthesis/metrics/catalog";
import type { GeographyPlace, GeographyResult } from "@/lib/synthesis/metrics/geography";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import { formatMetric, formatMetricExact } from "@/lib/views/dashboards/chart-model";
import { hasRegionMap, MAP_STEPS, mapModel } from "@/lib/views/dashboards/geography-model";
import { useSize } from "./use-size";

interface Shape {
  code: string | null;
  path: string;
}

const MIN_HEIGHT = 140;
/** A place without a value. */
const GROUND = "color-mix(in oklab, var(--ds-fg) 11%, var(--ds-app))";
/** The share of the chart color in each step, over the ground. */
const STEP_SHARE = [0, 24, 43, 62, 81, 100] as const;

/**
 * A measure by place: a choropleth in the sequential blue, or a table. Countries on Natural Earth
 * shapes, states of the United States on Census shapes; `d3-geo` is loaded in the browser only.
 */
export function GeographyChart({
  query,
  result,
  unit,
  label,
  valueLabel,
  samplesLabel,
  fill = false,
  compact = false,
}: {
  query: GeographyQuery;
  result: GeographyResult;
  unit: MetricUnit;
  /** The map, for its accessible name. */
  label: string;
  /** What the value is. */
  valueLabel: string;
  /** What is behind it. */
  samplesLabel: string;
  /** Take the height of the place it is in. */
  fill?: boolean;
  /** A small chart of a group-by: the map alone, without the notes under it. */
  compact?: boolean;
}) {
  const { country } = query;
  const drawable = !country || hasRegionMap(country);
  const [asTable, setAsTable] = useState(false);
  const { places, located } = result;
  const placeHeader = country ? "Region" : "Country";
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", fill ? "h-full" : "h-80")}>
      {places.length === 0 ? (
        <div className="min-h-0 flex-1">
          <EmptyState
            icon={MapPin}
            title="No location in this time range"
            description={
              located.matched === 0
                ? "No trace matches. Try a longer range or fewer filters."
                : "The matching traces carry no location. Settings name the attributes it is read from."
            }
          />
        </div>
      ) : asTable || !drawable ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <DataTable
            caption={label}
            density="compact"
            rows={[...places]}
            rowKey={({ code }) => code}
            columns={[
              {
                id: "place",
                header: placeHeader,
                cell: ({ code }: GeographyPlace) => placeName(code),
              },
              ...(unit === "count"
                ? []
                : [
                    {
                      id: "samples",
                      header: samplesLabel,
                      align: "right" as const,
                      width: "6rem",
                      cell: ({ samples }: GeographyPlace) => formatInteger(samples),
                    },
                  ]),
              {
                id: "value",
                header: valueLabel,
                align: "right" as const,
                width: "8rem",
                cell: ({ value }: GeographyPlace) => formatMetricExact(value, unit),
              },
            ]}
          />
        </div>
      ) : (
        <Choropleth
          country={country ?? null}
          places={places}
          unit={unit}
          label={label}
          onFailed={() => setAsTable(true)}
        />
      )}
      <div
        className={cn(
          "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle",
          compact && "hidden",
        )}
      >
        {places.length > 0 ? (
          <span>
            {formatInteger(located.traces)} of {formatInteger(located.matched)} traces have a{" "}
            {country ? "region" : "location"}.
          </span>
        ) : null}
        {drawable ? null : <span>There is no map of the regions of {placeName(country)}.</span>}
        {result.resolvesAddresses ? null : (
          <span>
            IP addresses are not resolved here: download DB-IP Lite with{" "}
            <code className="font-mono">geo:download</code> and set{" "}
            <code className="font-mono">GEO_DATABASE_PATH</code>.
          </span>
        )}
        <a
          href="https://db-ip.com"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-fg"
        >
          IP Geolocation by DB-IP
        </a>
        {places.length > 0 && drawable ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setAsTable((table) => !table)}
          >
            {asTable ? "Show the map" : "Show as table"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Choropleth({
  country,
  places,
  unit,
  label,
  onFailed,
}: {
  country: string | null;
  places: readonly GeographyPlace[];
  unit: MetricUnit;
  label: string;
  onFailed: () => void;
}) {
  const [hostRef, { width, height }] = useSize<HTMLDivElement>();
  const [shapes, setShapes] = useState<readonly Shape[] | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const { stepOf, max } = useMemo(() => mapModel(places), [places]);
  const placeOf = useMemo(() => new Map(places.map((place) => [place.code, place])), [places]);
  const plotHeight = Math.max(MIN_HEIGHT, height);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new closure of `onFailed` is no new map.
  useEffect(() => {
    if (width === 0) return;
    let stale = false;
    loadShapes(country, width, plotHeight).then(
      (next) => !stale && setShapes(next),
      () => !stale && onFailed(),
    );
    return () => {
      stale = true;
    };
  }, [country, width, plotHeight]);

  const read = (code: string) => {
    const place = placeOf.get(code);
    return `${placeName(code)}: ${place ? formatMetric(place.value, unit) : "no trace"}`;
  };
  return (
    <>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden">
        {shapes && width > 0 ? (
          <svg
            width={width}
            height={plotHeight}
            role="img"
            aria-label={`${label}. Highest: ${places
              .slice(0, 3)
              .map(({ code }) => read(code))
              .join(", ")}. "Show as table" lists them all.`}
            className="block"
            onPointerLeave={() => setHover(null)}
          >
            {shapes.map(({ code, path }, index) => (
              <path
                // biome-ignore lint/suspicious/noArrayIndexKey: two shapes can have one code, or none.
                key={index}
                d={path}
                className="stroke-app [stroke-width:0.5px] hover:stroke-fg"
                style={{ fill: stepColor((code && stepOf.get(code)) || 0) }}
                onPointerEnter={() => setHover(code)}
              />
            ))}
          </svg>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-fg-muted tabular-nums">
        <span>0</span>
        <span aria-hidden className="flex">
          {Array.from({ length: MAP_STEPS }, (_, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a step is its position.
              key={index}
              className="h-2 w-6 first:rounded-l-sm last:rounded-r-sm"
              style={{ background: stepColor(index + 1) }}
            />
          ))}
        </span>
        <span>{formatMetric(max, unit)}</span>
        <span className="ml-auto truncate text-fg">{hover ? read(hover) : null}</span>
      </div>
    </>
  );
}

async function loadShapes(
  country: string | null,
  width: number,
  height: number,
): Promise<readonly Shape[]> {
  const [{ geoAlbersUsa, geoNaturalEarth1, geoPath }, { feature }, atlas] = await Promise.all([
    import("d3-geo"),
    import("topojson-client"),
    country ? import("us-atlas/states-10m.json") : import("world-atlas/countries-110m.json"),
  ]);
  const topology = atlas.default as unknown as Parameters<typeof feature>[0];
  const collection = feature(
    topology,
    topology.objects[country ? "states" : "countries"],
  ) as unknown as GeoJSON.FeatureCollection;
  const features = collection.features.filter(
    // Nobody lives there, and it takes a third of the height.
    ({ properties }) => country !== null || properties?.name !== "Antarctica",
  );
  const projection = (country ? geoAlbersUsa() : geoNaturalEarth1()).fitSize([width, height], {
    type: "FeatureCollection",
    features,
  });
  const path = geoPath(projection);
  return features.flatMap((shape) => {
    const d = path(shape);
    const code = country
      ? regionOfShape(shape.id)
      : countryOfShape(shape.id, shape.properties?.name);
    return d ? [{ code, path: d }] : [];
  });
}

function stepColor(step: number): string {
  return step === 0
    ? GROUND
    : `color-mix(in oklab, var(--ds-chart-1) ${STEP_SHARE[step]}%, ${GROUND})`;
}
