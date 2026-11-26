import type { ParseResult } from "./ast";
import type { RqlTableName, RqlType } from "./catalog";
import { checkQuery, type ParamValue } from "./check";
import { RqlCompileError, type RqlError } from "./errors";
import { RQL_LIMITS } from "./limits";
import { rewriteSelect } from "./rewrite";
import { type RqlWindow, resolveWindow } from "./window";

export interface RqlCompileOptions {
  /** The time the query runs at: the end of the default window. */
  now: Date;
  /** The window the caller asks for. The default is the last `defaultWindowHours` before `now`. */
  window?: RqlWindow;
}

export type RqlCompileResult =
  | {
      ok: true;
      /** Postgres SQL over the views of the `rql` schema. The output columns are `c1`, `c2`... */
      sql: string;
      /** The values of `$1`, `$2`...: `$1` and `$2` are the window bounds. */
      params: ParamValue[];
      /** The index in `params` of the LIMIT: a parameter of its own, shared with no literal. */
      limitParam: number;
      /** The name and the type of each output column, in the order of `c1`, `c2`... */
      columns: { name: string; type: RqlType }[];
      table: RqlTableName;
      window: { from: string; to: string };
      /** The most rows the query gives: its LIMIT, lowered to `maxLimit`. */
      limit: number;
    }
  | { ok: false; error: RqlError };

/** Compiles query text with a parser: parse, check, then rewrite. Never throws on a query. */
export function compileQuery(
  text: string,
  parse: (text: string) => ParseResult,
  options: RqlCompileOptions,
): RqlCompileResult {
  try {
    if (text.trim() === "") {
      return {
        ok: false,
        error: {
          code: "empty_query",
          message: "The query is empty.",
          fix: "Write one SELECT statement, for example: select count(*) from traces.",
        },
      };
    }
    const window = resolveWindow(options.now, options.window);
    const select = checkQuery(parse(text));
    const limit = Math.min(select.limit ?? RQL_LIMITS.defaultLimit, RQL_LIMITS.maxLimit);
    const { sql, params, limitParam } = rewriteSelect(select, window, limit);
    return {
      ok: true,
      sql,
      params,
      limitParam,
      columns: select.items.map((item) => ({ name: item.name, type: item.type })),
      table: select.table.name,
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      limit,
    };
  } catch (error) {
    if (error instanceof RqlCompileError) return { ok: false, error: error.error };
    throw error;
  }
}
