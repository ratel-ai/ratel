"use client";

import { SegmentedControl } from "@ratel/design-system/tabs";
import { usePathname, useRouter } from "next/navigation";
import type { EvalStatusFilter } from "@/lib/views/evals/paths";

const ALL = "all";

/** RC-323: All or only the suggested evals; the choice lives in the URL (`?status=suggested`) with the task. */
export function StatusFilter({
  value,
  task,
  total,
  suggested,
}: {
  value: EvalStatusFilter;
  task: string | null;
  total: number;
  suggested: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <SegmentedControl<"all" | "suggested">
      label="Show"
      value={value ?? ALL}
      options={[
        {
          value: ALL,
          label: (
            <span className="inline-flex gap-1">
              All<span className="text-fg-subtle tabular-nums">{total}</span>
            </span>
          ),
        },
        {
          value: "suggested",
          label: (
            <span className="inline-flex gap-1">
              Suggested<span className="text-fg-subtle tabular-nums">{suggested}</span>
            </span>
          ),
        },
      ]}
      onValueChange={(next) => {
        const search = new URLSearchParams();
        if (task) search.set("task", task);
        if (next === "suggested") search.set("status", next);
        router.push(search.size > 0 ? `${pathname}?${search}` : pathname);
      }}
    />
  );
}
