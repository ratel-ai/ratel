import type { SqlQuery } from "@/lib/contracts/query";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { type MetricsDb, QueryError, runQuery } from "@/lib/synthesis/metrics/query";
import type { Measurement } from "@/lib/views/alerts/domain";
// Kind sql runs through the seam this module registers.
import "@/lib/synthesis/rql/query";

const NUMERIC_TYPES: readonly string[] = ["number", "integer"];
/** Kind sql reads through the RQL pool: the primary database is never asked. */
const RQL_ONLY = {
  execute: () => Promise.reject(new Error("a query of kind sql reads through the RQL pool")),
} as unknown as MetricsDb;

/**
 * RQL text on the read-only RQL path, with its own limits, over the rule's window. A refusal of
 * RQL, or a result that is not one row with one number, is the error the rule shows.
 */
export async function measureSqlValue(
  projectId: string,
  query: SqlQuery,
  { since, until }: QueryScope,
): Promise<Measurement | { error: string }> {
  try {
    const { columns, rows } = await runQuery(projectId, query, { since, until }, RQL_ONLY);
    if (columns.length !== 1 || !NUMERIC_TYPES.includes(columns[0].type))
      return { error: "The query must give one column with a number." };
    if (rows.length > 1) return { error: `The query gave ${rows.length} rows: it must give one.` };
    const value = rows[0]?.[0];
    return { value: typeof value === "number" ? value : null };
  } catch (error) {
    if (error instanceof QueryError)
      return { error: error.detail ? `${error.message} Fix: ${error.detail.fix}` : error.message };
    throw error;
  }
}
