import type { Span } from "./ast";

/**
 * The errors of the compiler. Each one has a stable code, a message that names the problem and a
 * fix that tells the agent what to write. `at` is the place in the query text, when it is known.
 */

export type RqlErrorCode =
  | "empty_query"
  | "syntax_error"
  | "multiple_statements"
  | "not_a_select"
  | "set_operation"
  | "cte"
  | "join"
  | "subquery"
  | "missing_from"
  | "multiple_tables"
  | "table_function"
  | "unknown_table"
  | "unknown_column"
  | "unknown_function"
  | "postgres_syntax"
  | "unsupported_clause"
  | "wrong_arguments"
  | "type_mismatch"
  | "aggregate_misuse"
  | "ungrouped_column"
  | "invalid_literal"
  | "invalid_limit"
  | "invalid_window"
  | "query_too_long"
  | "too_many_columns"
  | "too_many_items";

export interface RqlError {
  code: RqlErrorCode;
  message: string;
  fix: string;
  at?: Span;
}

/** Thrown inside the checker and caught by `compileParsed`; never leaves the module. */
export class RqlCompileError extends Error {
  constructor(readonly error: RqlError) {
    super(error.message);
  }
}

/** Stops the check with this error. */
export function fail(code: RqlErrorCode, message: string, fix: string, at?: Span): never {
  throw new RqlCompileError(at ? { code, message, fix, at } : { code, message, fix });
}

/**
 * The candidate nearest to `name`: a candidate that lists `name` as a hint, or else the one at the
 * smallest edit distance when that distance is small for the length of the name.
 */
export function nearestName(
  name: string,
  candidates: readonly { name: string; hints?: readonly string[] }[],
): string | undefined {
  const wanted = name.toLowerCase();
  const hinted = candidates.find((candidate) => candidate.hints?.includes(wanted));
  if (hinted) return hinted.name;
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(wanted, candidate.name);
    if (!best || distance < best.distance) best = { name: candidate.name, distance };
  }
  if (!best) return undefined;
  return best.distance <= Math.max(2, Math.floor(wanted.length / 3)) ? best.name : undefined;
}

/** The Levenshtein distance: the fewest one-character inserts, deletes and changes. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const change = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, change));
    }
    previous = current;
  }
  return previous[b.length];
}
