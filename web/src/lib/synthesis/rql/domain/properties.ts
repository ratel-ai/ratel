import { columnProperty, MAX_PROPERTY_NAME_CHARS } from "@/lib/contracts/trace-properties";
import type { RqlTable } from "./catalog";
import { nearestName, type RqlError } from "./errors";

/**
 * The trace properties of the project a query runs for (ADR-0012), as the caller read them: the
 * compiler stays pure. `properties['name']` reads an indexed name only: a property that is only
 * detected, or that a person stopped, has no values to read, and a query on it is refused with the
 * fix. A standard property that is a column of every trace is read through its column.
 */

export interface RqlProperties {
  /** The names whose values Ratel stores. */
  indexed: readonly string[];
  /** The names ingest saw and does not index. They make the refusal say "not indexed". */
  detected?: readonly string[];
}

/**
 * What a compile reads `properties['name']` against: the project's names, or `"any"` for a check of
 * the shape alone (the columns of a text, before a run), where every name a property can have reads.
 */
export type RqlPropertyCheck = RqlProperties | "any";

/** Where a person indexes a property. The console links to it; an agent reads it. */
export const PROPERTY_SETTINGS = "Settings > General > Trace properties";

/** The refusal of a read of `name`, or null when the name can be read on `table`. */
export function propertyRefusal(
  name: string,
  table: Pick<RqlTable, "name" | "columns">,
  properties: RqlPropertyCheck = { indexed: [] },
): Omit<RqlError, "at"> | null {
  if (name.length > MAX_PROPERTY_NAME_CHARS)
    return {
      code: "wrong_arguments",
      message: `A property name has ${name.length} characters. A property name has at most ${MAX_PROPERTY_NAME_CHARS} characters.`,
      fix: "Give the name of an indexed property. describe_rql_schema lists them.",
    };
  const column = columnProperty(name);
  if (column) {
    const own = table.columns.some((candidate) => candidate.name === column.rqlColumn);
    const read =
      column.rqlColumn === "models" ? "contains(models, 'name') or each(models)" : column.rqlColumn;
    return {
      code: "property_is_column",
      message: `${name} is a column of every trace, not a stored property.`,
      fix: own
        ? `Write ${read}.`
        : `Read it on the traces table: ${read}. The table ${table.name} has no such column.`,
    };
  }
  if (properties === "any" || properties.indexed.includes(name)) return null;
  return notIndexed(name, properties);
}

/**
 * The refusal of a property that is not indexed: its name, and the fix. The console's metric form
 * and `runQuery` give it for a filter or a group-by too.
 */
export function notIndexed(
  name: string,
  properties: RqlProperties = { indexed: [] },
): Omit<RqlError, "at"> {
  const near = properties.detected?.includes(name)
    ? undefined
    : nearestName(
        name,
        properties.indexed.map((indexed) => ({ name: indexed })),
      );
  return {
    code: "property_not_indexed",
    property: name,
    message: `The property ${name} is not indexed: Ratel stores no values of it.`,
    fix: `${near ? `Did you mean ${near}? ` : ""}Index it in project settings (${PROPERTY_SETTINGS}), then run the query again.`,
  };
}
