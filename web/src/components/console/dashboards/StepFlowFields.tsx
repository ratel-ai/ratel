"use client";

import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { useId } from "react";
import {
  STEP_FLOW_LIMITS,
  STEP_FLOW_NODES,
  STEP_FLOW_STARTS,
  type StepFlowMode,
  type StepFlowNode,
  type StepFlowQuery,
  type StepFlowStart,
} from "@/lib/contracts/query";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import { flowNodeLabel, flowNodeNoun } from "@/lib/views/dashboards/widget";
import { Choice } from "./MetricFields";

const START_LABELS: Readonly<Record<StepFlowStart, string>> = {
  none: "All traces",
  agent: "Agent",
  intent: "Intent",
};
const MODES: readonly { value: StepFlowMode; label: string }[] = [
  { value: "every_call", label: "Every call" },
  { value: "before", label: "What comes before" },
];

/** What a step flow's nodes are, where it starts, which way it reads and how far. */
export function StepFlowFields({
  query,
  facets,
  onChange,
}: {
  query: StepFlowQuery;
  facets: TraceFilterBarFacets;
  onChange: (query: StepFlowQuery) => void;
}) {
  const namesId = useId();
  const names = namesOf(query.node, facets);
  const { target: _, ...rest } = query;
  const limit = (key: "steps" | "nodes", value: string) => {
    const { min, max } = STEP_FLOW_LIMITS[key];
    const number = Number.parseInt(value, 10);
    if (Number.isFinite(number))
      onChange({ ...query, [key]: Math.min(max, Math.max(min, number)) });
  };
  return (
    <div className="flex flex-col gap-3">
      <Choice label="Read">
        <div className="flex">
          <SegmentedControl
            label="Read"
            options={MODES}
            value={query.mode}
            onValueChange={(mode) =>
              onChange(
                mode === "before" ? { ...rest, mode, target: names[0] ?? "" } : { ...rest, mode },
              )
            }
          />
        </div>
      </Choice>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Field label="Steps are" className="min-w-36 flex-1">
          {(control) => (
            <Select
              {...control}
              className="w-full"
              options={STEP_FLOW_NODES.map((value) => ({ value, label: flowNodeLabel(value) }))}
              value={query.node}
              onValueChange={(value) => {
                const node = value as StepFlowNode;
                // Another kind of node has other names.
                const target = namesOf(node, facets)[0] ?? "";
                onChange({ ...rest, node, ...(query.mode === "before" ? { target } : {}) });
              }}
            />
          )}
        </Field>
        {query.mode === "before" ? (
          <Field label="Before" className="min-w-40 flex-1">
            {(control) => (
              <Input
                {...control}
                value={query.target ?? ""}
                list={namesId}
                maxLength={500}
                autoComplete="off"
                placeholder={`Name the ${flowNodeNoun(query.node)}`}
                onChange={(event) => onChange({ ...query, target: event.currentTarget.value })}
              />
            )}
          </Field>
        ) : null}
        <datalist id={namesId}>
          {names.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <Field label="Start by" className="min-w-32 flex-1">
          {(control) => (
            <Select
              {...control}
              className="w-full"
              options={STEP_FLOW_STARTS.map((value) => ({ value, label: START_LABELS[value] }))}
              value={query.start}
              onValueChange={(start) => onChange({ ...query, start: start as StepFlowStart })}
            />
          )}
        </Field>
        {(["steps", "nodes"] as const).map((key) => (
          <Field key={key} label={key === "steps" ? "Steps" : "Per step"} className="w-20">
            {(control) => (
              <Input
                {...control}
                key={query[key]}
                type="number"
                min={STEP_FLOW_LIMITS[key].min}
                max={STEP_FLOW_LIMITS[key].max}
                defaultValue={query[key]}
                onBlur={(event) => limit(key, event.currentTarget.value)}
              />
            )}
          </Field>
        ))}
      </div>
    </div>
  );
}

/** The names the project's traces have. A skill has no facet: a person writes it. */
function namesOf(node: StepFlowNode, facets: TraceFilterBarFacets): string[] {
  const values = {
    tool: facets.tool,
    agent: facets.agent,
    mcp_server: facets.server,
    model: facets.model,
    skill: undefined,
  }[node];
  return (values ?? []).map(({ value }) => value);
}
