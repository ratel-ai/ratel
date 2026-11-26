"use client";

import { DataTable } from "@ratel/design-system/data-table";
import { EmptyState } from "@ratel/design-system/states";
import { Table2 } from "lucide-react";
import type { SqlResult } from "@/lib/synthesis/metrics/query";
import { chartModel } from "@/lib/views/dashboards/chart-model";
import { sqlAsMetric, sqlResultNotes } from "@/lib/views/dashboards/sql-chart";
import { MetricChart } from "./MetricChart";

const NUMERIC_TYPES: readonly string[] = ["number", "integer"];
const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/** The rows of an RQL query: a chart when they have one time column and numbers, else a table. */
export function SqlBody({
  result,
  label,
  fill,
}: {
  result: SqlResult;
  label: string;
  fill: boolean;
}) {
  if (result.rows.length === 0)
    return (
      <EmptyState
        icon={Table2}
        title="No rows in this time range"
        description="Try a longer range, or change the query."
      />
    );
  const metric = sqlAsMetric(result);
  // The notes show under a chart as under a table: a cut result never looks whole.
  const notes = sqlResultNotes(result).map((note) => (
    <p key={note} className="shrink-0 text-xs text-fg-subtle">
      {note}
    </p>
  ));
  if (metric)
    return (
      // A filled chart takes the height the notes leave, so a note never covers its axis.
      <div
        className={
          fill ? "flex h-full min-h-0 min-w-0 flex-col gap-2" : "flex min-w-0 flex-col gap-2"
        }
      >
        <div className={fill ? "flex min-h-0 flex-1 flex-col" : undefined}>
          <MetricChart
            chart="line"
            model={chartModel(metric, "avg", "count", "line")}
            result={metric}
            unit="count"
            label={label}
            fill={fill}
          />
        </div>
        {notes}
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <DataTable
        caption={label}
        density="compact"
        rows={result.rows.map((cells, index) => ({ index, cells }))}
        rowKey={({ index }) => String(index)}
        columns={result.columns.map(({ name, type }, column) => ({
          id: `${column}`,
          header: name,
          className: "max-w-0 truncate",
          ...(NUMERIC_TYPES.includes(type) ? { align: "right" as const } : {}),
          cell: ({ cells }: { cells: unknown[] }) => cellText(cells[column]),
        }))}
      />
      {notes}
    </div>
  );
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return NUMBER.format(value);
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
