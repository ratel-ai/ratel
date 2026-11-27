import { type GroupBy, isGrouped, propertyOf, type Query } from "@/lib/contracts/query";
import { withClause } from "@/lib/synthesis/traces/trace-filter-clauses";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";

/**
 * The query of one value of a group-by (RTL-398): the same query with one more clause, the value's
 * or its absence, and no group-by. Safe for the browser: a small chart's links filter by its value.
 */

/** The query of one value: one more clause, its value or its absence, and no group-by. */
export function groupQuery(query: Query, value: string | null): Query {
  if (!isGrouped(query)) return query;
  const { groupBy, groupLimit: _, ...rest } = query;
  return { ...rest, filters: withClause(rest.filters, valueClause(groupBy, value)) } as Query;
}

/** The clause that keeps the traces of one value of a group-by, or of none. */
export function valueClause(by: GroupBy, value: string | null): TraceFilter {
  const property = propertyOf(by);
  if (property !== undefined)
    return value === null
      ? { withoutProperties: [property] }
      : { properties: { [property]: [value] } };
  const field = by as Exclude<GroupBy, object>;
  return value === null ? { without: [field] } : { [`${field}s`]: [value] };
}
