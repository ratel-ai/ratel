import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";

/** A filter as a list of clauses that must all match. Safe for the browser. */

/** A filter's clauses, its own properties first. */
export function clausesOf({ and = [], ...own }: TraceFilter): readonly TraceFilter[] {
  return [own, ...and.flatMap(clausesOf)];
}

/** The filter with another clause. One that says nothing new is not added. */
export function withClause<F extends TraceFilter>(filter: F, clause: TraceFilter | undefined): F {
  const said = new Set(clausesOf(filter).map(clauseKey));
  const added = clause
    ? clausesOf(clause).filter((each) => clauseKey(each) !== "[]" && !said.has(clauseKey(each)))
    : [];
  return added.length > 0 ? { ...filter, and: [...(filter.and ?? []), ...added] } : filter;
}

/** Whether two clauses keep the same traces by their wording. */
function clauseKey(clause: TraceFilter): string {
  return JSON.stringify(
    Object.entries(clause)
      .flatMap(([name, value]): [string, unknown][] => {
        // A filter of a metric of scores names a scorer too: it is no property of a trace.
        if (name === "scorer" || name === "and" || value === undefined) return [];
        if (!Array.isArray(value)) return [[name, value]];
        return value.length > 0 ? [[name, [...new Set(value)].sort()]] : [];
      })
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/**
 * The fewest clauses that keep the same traces. Two sets of one property become one only where
 * that loses nothing: one holds the other, or the property has one value per trace.
 */
export function simplified(filter: TraceFilter): TraceFilter {
  const [first, ...rest] = clausesOf(filter);
  let own: TraceFilter = { ...first };
  const and: TraceFilter[] = [];
  for (const clause of rest) {
    const left: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(clause) as [keyof TraceFilter, unknown][]) {
      if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
      const merged = mergedValue(name, own[name], value);
      if (merged === undefined) left[name] = value;
      else own = { ...own, [name]: merged };
    }
    if (clauseKey(left as TraceFilter) !== "[]") and.push(left as TraceFilter);
  }
  return and.length > 0 ? { ...own, and } : own;
}

const ONE_PER_TRACE: readonly (keyof TraceFilter)[] = [
  "services",
  "environments",
  "users",
  "sessions",
];

function mergedValue(name: keyof TraceFilter, a: unknown, b: unknown): unknown {
  if (a === undefined || (Array.isArray(a) && a.length === 0)) return b;
  if (typeof a === "number" && typeof b === "number") return Math.max(a, b);
  // Each absence must hold: the names add up.
  if ((name === "withoutProperties" || name === "without") && Array.isArray(a) && Array.isArray(b))
    return [...new Set([...a, ...b])];
  if (name === "properties") return mergedProperties(a as PropertyValues, b as PropertyValues);
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b ? a : undefined;
  return mergedValues(a, b, ONE_PER_TRACE.includes(name));
}

type PropertyValues = NonNullable<TraceFilter["properties"]>;

/** Properties of other names combine; a trace has one value of a property, as of a service. */
function mergedProperties(a: PropertyValues, b: PropertyValues): PropertyValues | undefined {
  const merged: Record<string, readonly string[]> = { ...a };
  for (const [name, values] of Object.entries(b)) {
    const both = Object.hasOwn(merged, name) ? mergedValues(merged[name], values, true) : values;
    if (both === undefined) return undefined;
    merged[name] = both;
  }
  return merged;
}

function mergedValues(
  a: readonly unknown[],
  b: readonly unknown[],
  onePerTrace: boolean,
): readonly string[] | undefined {
  const both = a.filter((value) => b.includes(value));
  if (both.length === a.length) return a as readonly string[];
  if (both.length === b.length) return b as readonly string[];
  return onePerTrace && both.length > 0 ? (both as string[]) : undefined;
}
