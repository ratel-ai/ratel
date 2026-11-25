"use client";

import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { useId } from "react";
import { FLOW_LIMITS, FLOW_NODES, type FlowNode, type FlowQuery } from "@/lib/contracts/query";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import { flowNodeLabel } from "@/lib/views/dashboards/widget";

/** What a flow moves between, and the part of it that is drawn. */
export function FlowFields({
  query,
  facets,
  onChange,
}: {
  query: FlowQuery;
  facets: TraceFilterBarFacets;
  onChange: (query: FlowQuery) => void;
}) {
  const namesId = useId();
  const names =
    query.node === "tool" ? facets.tool : query.node === "agent" ? (facets.agent ?? []) : [];
  const noun = flowNodeLabel(query.node).toLowerCase().slice(0, -1);
  const end = (key: "start" | "end", value: string) => {
    const { [key]: _, ...rest } = query;
    onChange(value.trim() ? { ...rest, [key]: value } : rest);
  };
  const limit = (key: "steps" | "edges", value: string) => {
    const { min, max } = FLOW_LIMITS[key];
    const number = Number.parseInt(value, 10);
    if (Number.isFinite(number))
      onChange({ ...query, [key]: Math.min(max, Math.max(min, number)) });
  };
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <Field label="Move between" className="min-w-40 flex-1">
        {(control) => (
          <Select
            {...control}
            className="w-full"
            options={FLOW_NODES.map((value) => ({ value, label: flowNodeLabel(value) }))}
            value={query.node}
            onValueChange={(value) => {
              // Another kind of node has other names.
              const { start: _, end: __, ...rest } = query;
              onChange({ ...rest, node: value as FlowNode });
            }}
          />
        )}
      </Field>
      {(["start", "end"] as const).map((key) => (
        <Field
          key={key}
          label={key === "start" ? "Start at" : "End at"}
          className="min-w-40 flex-1"
        >
          {(control) => (
            <Input
              {...control}
              value={query[key] ?? ""}
              list={namesId}
              maxLength={500}
              autoComplete="off"
              placeholder={`Any ${noun}`}
              onChange={(event) => end(key, event.currentTarget.value)}
            />
          )}
        </Field>
      ))}
      <datalist id={namesId}>
        {names.map(({ value }) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      {(["steps", "edges"] as const).map((key) => (
        <Field key={key} label={key === "steps" ? "Steps" : "Edges"} className="w-24">
          {(control) => (
            <Input
              {...control}
              key={query[key]}
              type="number"
              min={FLOW_LIMITS[key].min}
              max={FLOW_LIMITS[key].max}
              defaultValue={query[key]}
              onBlur={(event) => limit(key, event.currentTarget.value)}
            />
          )}
        </Field>
      ))}
    </div>
  );
}
