"use client";

import { Select } from "@ratel/design-system/select";
import { X } from "lucide-react";
import { useState } from "react";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import {
  type PropertyBlock,
  propertyBlock,
  propertyOfValue,
  propertyOptions,
} from "@/lib/views/dashboards/properties";
import { PropertyBlockNote } from "./PropertyBlockNote";
import { usePropertyChoices } from "./PropertyChoicesProvider";

/**
 * The property part of a trace filter (RTL-396): pick a trace property, then one of its most
 * frequent values in the range; values of one property are alternatives, properties combine. A
 * detected property is listed off: picking it shows why, with the link that fixes it. Nothing
 * shows while the project has no property. The Flow, Step flow, Funnel and Map forms can use it
 * as it is: it edits `filter.properties` and nothing else.
 */
export function PropertyFilterFields({
  filter,
  onChange,
}: {
  filter: TraceFilter;
  onChange: (next: (current: TraceFilter) => TraceFilter) => void;
}) {
  const { projectId, choices } = usePropertyChoices();
  const [picked, setPicked] = useState<string | null>(null);
  const [block, setBlock] = useState<PropertyBlock | null>(null);
  const options = propertyOptions(choices);
  if (options.length === 0) return null;
  const active = Object.entries(filter.properties ?? {});
  const values = choices.indexed.find(({ name }) => name === picked)?.values ?? [];
  const chosen = picked ? (filter.properties?.[picked] ?? []) : [];

  const setValues = (name: string, next: readonly string[]) =>
    onChange((current) => {
      const { [name]: _, ...rest } = current.properties ?? {};
      const properties = next.length > 0 ? { ...rest, [name]: next } : rest;
      const { properties: __, ...without } = current;
      return Object.keys(properties).length > 0 ? { ...without, properties } : without;
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col">
          <Select
            aria-label="Filter by a trace property"
            placeholder="Trace property"
            className="min-w-44"
            options={options}
            value={picked ? `property:${picked}` : ""}
            onValueChange={(value) => {
              const name = propertyOfValue(value);
              if (!name) return;
              const blocked = propertyBlock(projectId, choices, name);
              setBlock(blocked);
              setPicked(blocked ? null : name);
            }}
          />
          {block ? <PropertyBlockNote block={block} onClose={() => setBlock(null)} /> : null}
        </div>
        {picked ? (
          <Select
            aria-label={`A value of ${picked}`}
            placeholder={values.length > 0 ? "Value" : "No value in the range"}
            disabled={values.length === 0}
            className="min-w-44"
            options={values
              .filter(({ value }) => !chosen.includes(value))
              .map(({ value, count }) => ({ value, label: value, detail: `${count}` }))}
            value=""
            onValueChange={(value) => {
              setValues(picked, [...chosen, value]);
              setPicked(null);
            }}
          />
        ) : null}
      </div>
      {active.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Trace property filters">
          {active.map(([name, kept]) => (
            <li
              key={name}
              className="flex items-center gap-1 rounded-md border border-line bg-raised px-2 py-0.5 text-xs text-fg"
            >
              <span className="font-mono">{name}</span>
              <span className="text-fg-subtle">is</span>
              <span>{kept.join(" or ")}</span>
              <button
                type="button"
                aria-label={`Remove the filter of ${name}`}
                className="text-fg-subtle hover:text-fg"
                onClick={() => setValues(name, [])}
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
