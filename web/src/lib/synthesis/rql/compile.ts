import { pgsqlAstParser } from "./adapters/pgsql-ast-parser";
import { compileQuery, type RqlCompileOptions, type RqlCompileResult } from "./domain/compile";
import { type RqlCompletionUsage, savedQueryUsage } from "./domain/usage";

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
export type { RqlProperties, RqlPropertyCheck } from "./domain/properties";
export type { RqlCompiled } from "./domain/run";
export type { RqlCompletionUsage } from "./domain/usage";
export { NO_USAGE } from "./domain/usage";
export type { RqlWindow } from "./domain/window";

/** Compiles one RQL query with the `pgsql-ast-parser` adapter. */
export function compileRql(text: string, options: RqlCompileOptions): RqlCompileResult {
  return compileQuery(text, (query) => pgsqlAstParser.parse(query), options);
}

/** The names the saved RQL texts use, alone and two together, read with the compiler's parser. */
export function countRqlUsage(
  texts: readonly string[],
): Pick<RqlCompletionUsage, "uses" | "together"> {
  return savedQueryUsage(
    texts.flatMap((text) => {
      const parsed = pgsqlAstParser.parse(text);
      return parsed.ok ? [parsed.statements] : [];
    }),
  );
}
