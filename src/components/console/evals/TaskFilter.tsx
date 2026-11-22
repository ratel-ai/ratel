"use client";

import { Select } from "@ratel/design-system/select";
import { usePathname, useRouter } from "next/navigation";
import type { EvalStatusFilter } from "@/lib/views/evals/paths";
import type { TaskTag } from "@/lib/views/evals/view";

const ALL = "__all__";

/** Filter the suite by task; the task lives in the URL (`?task=`), and the status filter stays. */
export function TaskFilter({
  tasks,
  value,
  status = null,
}: {
  tasks: readonly TaskTag[];
  value: string | null;
  status?: EvalStatusFilter;
}) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <Select
      aria-label="Task"
      className="w-56"
      value={value ?? ALL}
      options={[
        { value: ALL, label: "All tasks" },
        ...tasks.map((task) => ({ value: task.id, label: task.label })),
      ]}
      onValueChange={(next) => {
        const search = new URLSearchParams();
        if (next !== ALL) search.set("task", next);
        if (status) search.set("status", status);
        router.push(search.size > 0 ? `${pathname}?${search}` : pathname);
      }}
    />
  );
}
