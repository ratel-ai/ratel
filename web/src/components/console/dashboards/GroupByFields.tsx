"use client";

import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { useState } from "react";
import { PropertyBlockNote } from "@/components/console/properties/PropertyBlockNote";
import { usePropertyChoices } from "@/components/console/properties/PropertyChoicesProvider";
import { GROUP_LIMITS, type GroupBy, type GroupedQuery } from "@/lib/contracts/query";
import { groupByOptions, groupLimitOf, NO_GROUP } from "@/lib/views/dashboards/grouped";
import {
  dimensionOfValue,
  dimensionValue,
  type PropertyBlock,
  propertyBlock,
  propertyOfValue,
} from "@/lib/views/dashboards/properties";

/**
 * The Group by control of the Flow, Step flow, Funnel and Map forms (RTL-398): task, user, session
 * or a trace property, as the Metric form lists them, and how many values get a small chart. A
 * property that is not indexed is not picked: the note says why, with the fix.
 */
export function GroupByFields<Q extends GroupedQuery>({
  query,
  onChange,
}: {
  query: Q;
  onChange: (query: Q) => void;
}) {
  const { projectId, choices } = usePropertyChoices();
  const [blocked, setBlocked] = useState<PropertyBlock | null>(null);
  const { groupBy: _, groupLimit: __, ...ungrouped } = query;
  const choose = (value: string) => {
    const property = propertyOfValue(value);
    const block = property === undefined ? null : propertyBlock(projectId, choices, property);
    setBlocked(block);
    if (block) return;
    onChange(
      value === NO_GROUP
        ? (ungrouped as Q)
        : { ...query, groupBy: dimensionOfValue(value) as GroupBy },
    );
  };
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <Field label="Group by" className="min-w-40 flex-1">
        {(control) => (
          <div className="flex flex-col">
            <Select
              {...control}
              className="w-full"
              options={groupByOptions(choices)}
              value={query.groupBy === undefined ? NO_GROUP : dimensionValue(query.groupBy)}
              onValueChange={(value) => choose(String(value))}
            />
            {blocked ? (
              <PropertyBlockNote block={blocked} onClose={() => setBlocked(null)} />
            ) : null}
          </div>
        )}
      </Field>
      {query.groupBy === undefined ? null : (
        <Field label="Values" className="w-24">
          {(control) => (
            <Input
              {...control}
              key={query.groupLimit ?? GROUP_LIMITS.default}
              type="number"
              min={GROUP_LIMITS.min}
              max={GROUP_LIMITS.max}
              defaultValue={query.groupLimit ?? GROUP_LIMITS.default}
              onBlur={(event) => {
                const limit = groupLimitOf(event.currentTarget.value);
                if (limit !== null) onChange({ ...query, groupLimit: limit });
              }}
            />
          )}
        </Field>
      )}
    </div>
  );
}
