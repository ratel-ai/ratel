"use client";

import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { X } from "lucide-react";
import type { ClustersQuery, ClustersView } from "@/lib/contracts/query";
import type { ClusterNames } from "@/lib/synthesis/metrics/clusters";
import { Choice } from "./MetricFields";

/** The choice that picks no name: no name is empty or starts with a space. */
const ADD = " add";
const SUBSETS: readonly { key: keyof ClusterNames; label: string; noun: string }[] = [
  { key: "clusters", label: "Clusters", noun: "cluster" },
  { key: "tools", label: "Tools", noun: "tool" },
  { key: "skills", label: "Skills", noun: "skill" },
  { key: "tasks", label: "Tasks", noun: "task" },
];

/** Which drawing of the stored intent map, and which part of it. */
export function ClustersFields({
  query,
  names,
  onChange,
}: {
  query: ClustersQuery;
  /** What the stored map has to pick from; absent until the preview read it. */
  names: ClusterNames | undefined;
  onChange: (query: ClustersQuery) => void;
}) {
  const pick = (key: keyof ClusterNames, values: string[]) => {
    const { [key]: _, ...rest } = query;
    onChange(values.length > 0 ? { ...rest, [key]: values } : rest);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <Choice label="View">
          <SegmentedControl
            label="View"
            options={[
              { value: "asks", label: "Asks" },
              { value: "tools", label: "Tools" },
            ]}
            value={query.view}
            onValueChange={(view) => onChange({ ...query, view: view as ClustersView })}
          />
        </Choice>
        <Field label="Minimum asks" className="w-32">
          {(control) => (
            <Input
              {...control}
              type="number"
              min={0}
              value={query.minSize ?? ""}
              placeholder="Any"
              onChange={(event) => {
                const { minSize: _, ...rest } = query;
                const size = Number.parseInt(event.currentTarget.value, 10);
                onChange(size > 0 ? { ...rest, minSize: size } : rest);
              }}
            />
          )}
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {SUBSETS.map(({ key, label, noun }) => {
          const chosen = query[key] ?? [];
          const rest = (names?.[key] ?? []).filter((name) => !chosen.includes(name));
          return (
            <Choice key={key} label={label}>
              <div className="flex flex-wrap gap-1.5">
                {chosen.map((name, index) => (
                  <button
                    key={name}
                    type="button"
                    // The name is text only: a cluster's comes from people's asks.
                    aria-label={`Remove ${noun} ${index + 1}`}
                    className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border border-line px-2 text-xs text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
                    onClick={() => pick(key, chosen.toSpliced(index, 1))}
                  >
                    <span className="truncate">{name}</span>
                    <X className="size-3 shrink-0 text-fg-muted" aria-hidden />
                  </button>
                ))}
              </div>
              <Select
                aria-label={`Add a ${noun}`}
                className="w-full"
                disabled={rest.length === 0}
                options={[
                  {
                    value: ADD,
                    label: chosen.length > 0 ? `Add a ${noun}` : `Every ${noun}`,
                  },
                  ...rest.map((name) => ({ value: name, label: name })),
                ]}
                value={ADD}
                onValueChange={(name) => {
                  if (name !== ADD) pick(key, [...chosen, String(name)]);
                }}
              />
            </Choice>
          );
        })}
      </div>
    </div>
  );
}
