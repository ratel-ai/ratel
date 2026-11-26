import type { ToolSuccess } from "../../shell/state";

/** run_rql's data (lib/mcp/operations/monitoring/rql.ts), as the view reads it. */
export interface RqlTable {
  summary: string;
  /** The name and the RQL type of each column. Names can repeat. */
  columns: { name: string; type: string }[];
  /** Arrays in the order of `columns`. */
  rows: unknown[][];
  /** The query had more rows than its limit. */
  truncated: boolean;
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/** The table of a result, or null when the data is not one. */
export function readTable(result: Pick<ToolSuccess, "data">): RqlTable | null {
  const data = result.data as Partial<RqlTable> | null | undefined;
  if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) return null;
  const columns = data.columns.filter(
    (column): column is RqlTable["columns"][number] =>
      typeof column?.name === "string" && typeof column?.type === "string",
  );
  if (columns.length !== data.columns.length) return null;
  return {
    summary: typeof data.summary === "string" ? data.summary : "",
    columns,
    rows: data.rows.filter(Array.isArray),
    truncated: data.truncated === true,
  };
}

/** One value as text: a number in en-US, a list or a map as JSON, no value as null. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return NUMBER.format(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** A number and an integer align right, as the console aligns numbers. */
export function isNumericType(type: string): boolean {
  return type === "number" || type === "integer";
}
