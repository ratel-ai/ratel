"use client";

import { SegmentedControl } from "@ratel/design-system/tabs";
import { usePathname, useRouter } from "next/navigation";
import type { StepsView } from "@/lib/readings/trace-signals/steps";
import { stepsViewHref } from "@/lib/views/tasks/steps-view";

/** The presets in plain words (DESIGN.md: no engine names). */
const OPTIONS: readonly { value: StepsView; label: string }[] = [
  { value: "all", label: "All steps" },
  { value: "tools", label: "Tools" },
  { value: "models", label: "Models" },
  { value: "intents", label: "Intents" },
  { value: "flow", label: "Flow" },
];

/**
 * Which steps a task or a session shows (`?steps=`, typed steps only). A
 * change keeps every other query value, the playhead and an open panel too.
 */
export function StepsViewControl({ value, className }: { value: StepsView; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <SegmentedControl
      label="Steps to show"
      options={OPTIONS}
      value={value}
      className={className}
      onValueChange={(next) => {
        if (next === value) return;
        router.replace(stepsViewHref(pathname, window.location.search, next), { scroll: false });
      }}
    />
  );
}
