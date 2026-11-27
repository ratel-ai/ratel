/**
 * Trace properties as the query object and RQL name them (RTL-396, ADR-0012): the longest name, how
 * many one filter names, and the standard properties that are columns of every trace already. A
 * column property is never read through `properties`: the query names its column or its dimension.
 * Pure and safe for the browser.
 */

/** The longest property name: the longest key ingest records (`ingest/properties/keys.ts`). */
export const MAX_PROPERTY_NAME_CHARS = 100;

/** The most properties one clause of a filter names. */
export const MAX_FILTER_PROPERTIES = 20;

/** A standard property that is a column of every trace: its dimension, and its RQL column. */
export interface ColumnProperty {
  /** The group-by of the metric form that reads it. */
  dimension: "user" | "session" | "environment" | "model" | "service";
  /** The RQL column of `traces` that holds it. A list for `model`. */
  rqlColumn: "user_id" | "session_id" | "environment" | "models" | "service_name";
}

/** The column properties, by their canonical name (`ingest/properties/standard.ts`). */
export const COLUMN_PROPERTIES: Readonly<Record<string, ColumnProperty>> = {
  user: { dimension: "user", rqlColumn: "user_id" },
  session: { dimension: "session", rqlColumn: "session_id" },
  environment: { dimension: "environment", rqlColumn: "environment" },
  model: { dimension: "model", rqlColumn: "models" },
  service: { dimension: "service", rqlColumn: "service_name" },
};

/** The column property of this name, or undefined for a property `properties` holds. */
export function columnProperty(name: string): ColumnProperty | undefined {
  return Object.hasOwn(COLUMN_PROPERTIES, name) ? COLUMN_PROPERTIES[name] : undefined;
}

/** Why a property name cannot be read through `properties`, or null when it can. */
export function propertyNameProblem(name: string): string | null {
  const column = columnProperty(name);
  if (column)
    return `"${name}" is a column of every trace, not a stored property: group by the dimension "${column.dimension}".`;
  if (name.length > MAX_PROPERTY_NAME_CHARS)
    return `A property name has at most ${MAX_PROPERTY_NAME_CHARS} characters.`;
  return null;
}
