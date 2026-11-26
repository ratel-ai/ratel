import { pgsqlAstParser } from "./adapters/pgsql-ast-parser";
import { compileQuery, type RqlCompileOptions, type RqlCompileResult } from "./domain/compile";

/**
 * The entry point of RQL: query text to Postgres SQL with bound parameters, or to an error with
 * a fix. No database access. `describeRqlSchema` describes the same catalog.
 */

export type { RqlTableName, RqlType } from "./domain/catalog";
export { RQL_VERSION } from "./domain/catalog";
export type { RqlCompileOptions, RqlCompileResult } from "./domain/compile";
export type { RqlSchemaDescription } from "./domain/describe";
export { describeRqlSchema } from "./domain/describe";
export type { RqlError, RqlErrorCode } from "./domain/errors";
export { RQL_LIMITS } from "./domain/limits";
export type { RqlPageFilter } from "./domain/page-filter";
export type { RqlCompiled } from "./domain/run";
export type { RqlWindow } from "./domain/window";

/** Compiles one RQL query with the `pgsql-ast-parser` adapter. */
export function compileRql(text: string, options: RqlCompileOptions): RqlCompileResult {
  return compileQuery(text, (query) => pgsqlAstParser.parse(query), options);
}
