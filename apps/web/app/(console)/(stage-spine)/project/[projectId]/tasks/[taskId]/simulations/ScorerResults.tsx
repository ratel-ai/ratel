"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import { EmptyState } from "@ratel/design-system/states";
import type { Tally } from "@/lib/views/eval-gate/types";
import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import { SCORER_KINDS } from "@/lib/views/task-scorers/types";

type ComparisonRow = { id: string; label: string; before: Tally; after: Tally };

export function ScorerResults({
  breakdown,
  group,
}: {
  breakdown: Record<string, unknown> | null;
  group: "task" | "fix";
}) {
  const values = breakdown?.[group] as Record<string, { before: Tally; after: Tally }> | undefined;
  const rows: ComparisonRow[] = SCORER_KINDS.flatMap((kind) =>
    values?.[kind] ? [{ id: kind, label: SCORER_LABELS[kind], ...values[kind] }] : [],
  );
  const columns: Column<ComparisonRow>[] = [
    { id: "scorer", header: "Scorer", cell: (row) => row.label },
    { id: "before", header: "Before", align: "right", cell: (row) => passRate(row.before) },
    { id: "after", header: "After", align: "right", cell: (row) => passRate(row.after) },
    {
      id: "change",
      header: "Change",
      align: "right",
      cell: (row) => {
        if (row.before.passRate === null || row.after.passRate === null) return "Not measured";
        const delta = Math.round((row.after.passRate - row.before.passRate) * 100);
        return (
          <span
            className={delta > 0 ? "text-success" : delta < 0 ? "text-danger" : "text-fg-muted"}
          >
            {delta > 0 ? "+" : ""}
            {delta} pts
          </span>
        );
      },
    },
  ];
  return (
    <DataTable
      caption={group === "task" ? "Task set scorer comparison" : "Fix tests scorer comparison"}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      empty={
        <EmptyState
          title="No scorer results yet"
          description="Run the simulation to compare the draft with the recorded runs."
        />
      }
    />
  );
}

function passRate(tally: Tally) {
  return tally.passRate === null
    ? "Not measured"
    : `${Math.round(tally.passRate * 100)}% · ${tally.passed}/${tally.total}`;
}
