import type { SqlQuery } from "@/lib/contracts/query";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { metricSeams, QueryError, type SqlResult } from "@/lib/synthesis/metrics/query";
import { compileRql, RQL_VERSION } from "./compile";
import { type RqlRunDeps, runRql } from "./run";

/**
 * Kind `sql` of the query object: `runQuery` sends it here through `metricSeams.sql`, which this
 * file fills on import. It has no flag check: each caller of `runQuery` is behind
 * `customMonitoring` already (`query_monitoring`, `run_rql`, the dashboards, Explore and the alerts).
 * The text is compiled at every run, so a saved query is checked again at load against the RQL of
 * today. The window of the scope is the window of the query; a time
 * condition in the text narrows it. The filter of the scope keeps the rows whose trace matches
 * (`domain/page-filter.ts`). Every refusal is a `QueryError` with the code, the message and the fix of RQL.
 */

export interface SqlQueryDeps {
  /** The runner's executor, gate, timeout and observer: the RQL pool's by default. */
  run: Partial<RqlRunDeps>;
  /** The RQL version of this build. A test gives a later one to reach the path of older queries. */
  rqlVersion: number;
}

type SqlRunner = NonNullable<typeof metricSeams.sql>;

metricSeams.sql = sqlQueryRunner();

/** The runner of kind `sql`. */
export function sqlQueryRunner(deps: Partial<SqlQueryDeps> = {}): SqlRunner {
  const { run = {}, rqlVersion = RQL_VERSION } = deps;
  return (projectId, query, scope) => runSqlQuery(projectId, query, scope, { run, rqlVersion });
}

async function runSqlQuery(
  projectId: string,
  query: SqlQuery,
  scope: QueryScope,
  { run, rqlVersion }: Pick<SqlQueryDeps, "run" | "rqlVersion">,
): Promise<SqlResult> {
  if (query.rqlVersion > rqlVersion)
    throw new QueryError(
      `The query is written in RQL version ${query.rqlVersion}, and this server knows version ${rqlVersion} at most.`,
      { code: "rql_version", fix: `Write the query in RQL version ${rqlVersion}.` },
    );
  const compiled = compileRql(query.text, {
    now: scope.until,
    window: { from: scope.since, to: scope.until },
    // The page's filter keeps the rows whose trace matches, as it does for the other kinds.
    ...(scope.filter ? { filter: scope.filter } : {}),
  });
  if (!compiled.ok) {
    const { code, message, fix } = compiled.error;
    throw new QueryError(
      query.rqlVersion < rqlVersion
        ? `The query was written for RQL version ${query.rqlVersion}, and no longer compiles in version ${rqlVersion}: ${message}`
        : message,
      { code, fix },
    );
  }
  const result = await runRql(compiled, { projectId }, run);
  if (!result.ok) {
    const { code, message, fix } = result.error;
    throw new QueryError(message, { code, fix });
  }
  return { kind: "sql", columns: result.columns, rows: result.rows, truncated: result.truncated };
}
