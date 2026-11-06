"use client";

import { Select } from "@ratel/design-system/select";
import { usePathname, useRouter } from "next/navigation";
import type { GraphChoice } from "@/lib/views/intents/map/labels";

/**
 * Which graph the page reads, when a project has more than one: the one Cloud
 * builds from every runtime, Cloud's per-runtime ones, and any a runtime
 * uploaded. The choice lives in the URL (`?graph=`); the default carries none.
 */
export function GraphPicker({
  choices,
  value,
  defaultKey,
}: {
  choices: readonly GraphChoice[];
  value: string;
  defaultKey: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  if (choices.length < 2) return null;
  return (
    <Select
      aria-label="Graph"
      options={choices.map((choice) => ({ value: choice.graphKey, label: choice.label }))}
      value={value}
      onValueChange={(next) => {
        router.push(
          next === defaultKey ? pathname : `${pathname}?graph=${encodeURIComponent(next)}`,
        );
      }}
      className="min-w-44"
    />
  );
}
