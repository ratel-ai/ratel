import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

/** Case-insensitive literal substring match for user-entered telemetry filters. */
export function containsText(column: SQLWrapper, value: string): SQL {
  const pattern = `%${value.replace(/[\\%_]/g, "\\$&")}%`;
  return sql`${column} ilike ${pattern} escape '\\'`;
}
