"use client";

import { Field } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import type { GeographyQuery } from "@/lib/contracts/query";
import { COUNTRY_CODES, placeName } from "@/lib/ingest/geo/codes";
import type { QueryChange } from "@/lib/views/dashboards/widget";
import { MetricFields } from "./MetricFields";

const WORLD = "world";
/** The one with a map first. */
const COUNTRIES = [
  "US",
  ...COUNTRY_CODES.filter((code) => code !== "US").sort((a, b) =>
    placeName(a).localeCompare(placeName(b), "en"),
  ),
];

/** What a map measures, and of which place. */
export function GeographyFields({
  query,
  onMeasure,
  onChange,
}: {
  query: GeographyQuery;
  onMeasure: (change: QueryChange) => void;
  onChange: (query: GeographyQuery) => void;
}) {
  return (
    <MetricFields query={query} filterableOnly onChange={onMeasure}>
      <Field label="Place" className="min-w-40 flex-1">
        {(control) => (
          <Select
            {...control}
            className="w-full"
            options={[
              { value: WORLD, label: "World, by country" },
              ...COUNTRIES.map((code) => ({
                value: code,
                label: `${placeName(code)}, by region`,
              })),
            ]}
            value={query.country ?? WORLD}
            onValueChange={(value) => {
              const { country: _, ...rest } = query;
              onChange(
                value === WORLD
                  ? { ...rest, level: "world" }
                  : { ...rest, level: "country", country: String(value) },
              );
            }}
          />
        )}
      </Field>
    </MetricFields>
  );
}
