import type { RqlType } from "./catalog";
import { RQL_LIMITS } from "./limits";

/**
 * The bounds of a result: a cell longer than `maxCellChars` is cut, and the rows stop before
 * their JSON passes `maxResultBytes`. Each cut marks the result truncated. The executor reads
 * rows with the same measure (`shapedRowBytes`), so it stops reading where the result stops.
 */

export interface ShapedRows {
  rows: unknown[][];
  /** A cell was cut, or a row was left out. */
  truncated: boolean;
}

/** The first `limit` rows, typed, cut to the cell cap and to the byte cap. */
export function shapeRows(
  raw: readonly unknown[][],
  types: readonly (RqlType | undefined)[],
  limit: number,
): ShapedRows {
  const rows: unknown[][] = [];
  // The executor stops reading once the rows pass the cap as it measures them, before typing: rows
  // past that measure mean it stopped, even when they fit the cap once typed.
  const read = raw.reduce((sum, row) => sum + shapedRowBytes(row), 0);
  let truncated = raw.length > limit || read > RQL_LIMITS.maxResultBytes;
  let bytes = 2; // the brackets of the JSON array
  for (const rawRow of raw.slice(0, limit)) {
    const cut = cutRow(rawRow.map((value, i) => normalizeValue(value, types[i])));
    const size = rowBytes(cut.row);
    if (bytes + size > RQL_LIMITS.maxResultBytes) {
      truncated = true;
      break;
    }
    bytes += size;
    rows.push(cut.row);
    truncated ||= cut.cut;
  }
  return { rows, truncated };
}

/** The bytes a raw row takes in the result once its cells are cut: what the executor counts. */
export function shapedRowBytes(row: readonly unknown[]): number {
  return rowBytes(cutRow(row).row);
}

/** The pg driver gives numeric and bigint values as strings, and timestamps as Dates. */
function normalizeValue(value: unknown, type: RqlType | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (type === "integer" || type === "number") {
    if (typeof value === "string" || typeof value === "bigint") return Number(value);
  }
  return value;
}

/**
 * A text over the cap keeps its first `maxCellChars` characters. A list or an object over the cap
 * (as JSON) becomes the first `maxCellChars` characters of its JSON, a text.
 */
function cutRow(row: readonly unknown[]): { row: unknown[]; cut: boolean } {
  let cut = false;
  const cells = row.map((value) => {
    const max = RQL_LIMITS.maxCellChars;
    if (typeof value === "string") {
      if (value.length <= max) return value;
      cut = true;
      return value.slice(0, max);
    }
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      const json = JSON.stringify(value);
      if (json.length <= max) return value;
      cut = true;
      return json.slice(0, max);
    }
    return value;
  });
  return { row: cells, cut };
}

/** The UTF-8 bytes of the row as JSON, and the comma after it. */
function rowBytes(row: readonly unknown[]): number {
  return Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
}
