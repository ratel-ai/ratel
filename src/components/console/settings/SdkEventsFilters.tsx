"use client";

import { FilterBar } from "@ratel/design-system/filter-bar";
import { Select } from "@ratel/design-system/select";
import type { ReactNode } from "react";
import type { SdkEventsState } from "@/lib/console/settings/sdk-events";

/** The value the "everything" option carries; the URL leaves the filter out. */
const ALL = "all";

/**
 * The event and source filters above the list. Each change is a new URL, so
 * the filtered list survives a reload and a shared link (DESIGN.md, Lists).
 */
export function SdkEventsFilters({
  state,
  typeOptions,
  sourceOptions,
  onChange,
  end,
}: {
  state: SdkEventsState;
  typeOptions: ReadonlyArray<{ value: string; label: string }>;
  sourceOptions: ReadonlyArray<{ value: string; label: string }>;
  onChange: (next: Partial<SdkEventsState>) => void;
  end?: ReactNode;
}) {
  return (
    <FilterBar
      search={
        <Select
          aria-label="Event"
          options={[{ value: ALL, label: "All events" }, ...typeOptions]}
          value={state.type || ALL}
          onValueChange={(value) => onChange({ type: value === ALL ? "" : value })}
          className="w-48"
        />
      }
      chips={
        <Select
          aria-label="Source"
          options={[{ value: ALL, label: "All sources" }, ...sourceOptions]}
          value={state.sourceId || ALL}
          onValueChange={(value) => onChange({ sourceId: value === ALL ? "" : value })}
          className="w-48"
        />
      }
      end={end}
    />
  );
}
