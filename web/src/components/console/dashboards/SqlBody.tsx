"use client";

import { DataTable } from "@ratel/design-system/data-table";
import { StatRow } from "@ratel/design-system/stat-row";
import { EmptyState } from "@ratel/design-system/states";
import { Table2 } from "lucide-react";
import type { SqlResult } from "@/lib/synthesis/metrics/query";
import { chartModel } from "@/lib/views/dashboards/chart-model";
import {
  chartChoices,
  drawnChart,
  sqlAsCategories,
  sqlAsMetric,
  sqlNumber,
  sqlResultNotes,
} from "@/lib/views/dashboards/sql-chart";
import type { MetricChartKind } from "@/lib/views/dashboards/types";
import { MetricChart } from "./MetricChart";

const NUMERIC_TYPES: readonly string[] = ["number", "integer"];
const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/**
 * The rows of an RQL text, drawn as its chart: a table of any rows, a number of one row, a line or
 * a bar over a time column, or bars of a text column. Rows the chart cannot draw show as a table,
 * with the reason.
 */
export function SqlBody({
  result,
  chart,
  label,
  fill,
}: {
  result: SqlResult;
  chart: MetricChartKind;
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
  const reason = chartChoices(result)[chart];
  // The notes show under a chart as under a table: a cut result never looks whole.
  const notes = [...(reason ? [reason] : []), ...sqlResultNotes(result)].map((note) => (
    <p key={note} className="shrink-0 text-xs text-fg-subtle">
      {note}
    </p>
  ));
  const drawn = drawnChart(chart, result);
  const timed = drawn === "line" || drawn === "bar" ? sqlAsMetric(result) : null;
  return (
    // A filled chart takes the height the notes leave, so a note never covers its axis.
    <div
      className={
        fill ? "flex h-full min-h-0 min-w-0 flex-col gap-2" : "flex min-w-0 flex-col gap-2"
      }
    >
      {drawn === "number" ? (
        <StatRow
          className="grid-cols-1 rounded-none border-0 lg:grid-cols-1 [&>*]:p-0"
          stats={[
            {
              label: result.columns.find(({ type }) => NUMERIC_TYPES.includes(type))?.name ?? label,
              value: cellText(sqlNumber(result)),
            },
          ]}
        />
      ) : timed && (drawn === "line" || drawn === "bar") ? (
        <div className={fill ? "flex min-h-0 flex-1 flex-col" : undefined}>
          <MetricChart
            chart={drawn}
            model={chartModel(timed, "avg", "number", drawn)}
            result={timed}
            unit="number"
            label={label}
            fill={fill}
          />
        </div>
      ) : drawn === "bar" ? (
        <CategoryBars result={result} label={label} />
      ) : (
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
      )}
      {notes}
    </div>
  );
}

/** One bar per value of the text column, as long as its share of the largest value. */
function CategoryBars({ result, label }: { result: SqlResult; label: string }) {
  const bars = sqlAsCategories(result);
  const largest = Math.max(
    0,
    ...bars.flatMap(({ values }) => values.map(({ value }) => Math.abs(value ?? 0))),
  );
  return (
    <ul aria-label={label} className="flex flex-col gap-1.5">
      {bars.flatMap(({ label: name, values }) =>
        values.map(({ series, value }) => {
          const key = series === null ? name : `${name} · ${series}`;
          return (
            <li key={key} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2">
              <span className="truncate text-xs text-fg-muted" title={key}>
                {key}
              </span>
              <span className="h-2 rounded-sm bg-bg-subtle">
                <span
                  className="block h-2 rounded-sm bg-chart-1"
                  style={{ width: `${largest > 0 ? (Math.abs(value ?? 0) / largest) * 100 : 0}%` }}
                />
              </span>
              <span className="text-right text-xs tabular-nums text-fg">{cellText(value)}</span>
            </li>
          );
        }),
      )}
    </ul>
  );
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return NUMBER.format(value);
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
