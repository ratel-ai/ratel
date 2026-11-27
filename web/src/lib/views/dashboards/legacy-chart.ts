import { compileRql } from "@/lib/synthesis/rql/compile";
import { chartChoices, defaultChart } from "@/lib/views/dashboards/sql-chart";
import type { MetricChartKind } from "@/lib/views/dashboards/types";

/**
 * The chart an older RQL widget (chart `sql`) drew: a line when its rows have one time column and
 * numbers, else a table. Read from the compiled columns, so no query runs. Server only: it takes
 * the compiler. A text that no longer compiles is a table, and shows its refusal.
 */
export function sqlChartOfText(text: string): MetricChartKind {
  const compiled = compileRql(text, { now: new Date(), console: true, properties: "any" });
  return compiled.ok ? defaultChart(chartChoices({ columns: compiled.columns })) : "table";
}
