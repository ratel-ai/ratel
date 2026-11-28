import type { SqlQuery } from "@/lib/contracts/query";
import { loadStoredPropertyNames } from "@/lib/ingest/properties/store";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { metricSeams, QueryError, type SqlResult } from "@/lib/synthesis/metrics/query";
import { compileRql, RQL_VERSION } from "./compile";
import { RQL_LIMITS } from "./domain/limits";
import type { RqlProperties } from "./domain/properties";
import {
  busyError,
  placeHeld,
  type RqlGate,
  type RqlRunDeps,
  rqlAgentGate,
  rqlAlertGate,
  rqlConsoleGate,
  runRql,
} from "./run";

/**
 * Kind `sql` of the query object: `runQuery` sends it here through `metricSeams.sql`, which this
 * file fills on import. It has no flag check: each caller of `runQuery` is behind
 * `customMonitoring` already (`query_monitoring`, `run_rql`, the dashboards, Explore and the alerts).
 * The text is compiled at every run, so a saved query is checked again at load against the RQL of
 * today. The place of the project in the gate of its path is taken before the compile: a query
 * waits up to `gateWaitMs` for one, and is refused before its text costs a parse when none comes
 * free. Each path has its gate (`scope.purpose`): the console (`parallelConsoleQueriesPerProject`),
 * an agent's `run_rql` (`parallelQueriesPerProject`), and an alert rule, which takes the alert
 * timeout too (`parallelAlertQueriesPerProject`). The window of
 * the scope is the window of the query, up to `consoleMaxWindowDays`, and by known time when the
 * scope says so; a time condition in the text narrows it. The filter of the scope keeps the rows whose trace matches
 * (`domain/page-filter.ts`). Every refusal is a `QueryError` with the code, the message and the fix of RQL.
 */

export interface SqlQueryDeps {
  /**
   * The runner's executor, timeout and observer: the RQL pool's by default. Its gate is the
   * console's: `rqlConsoleGate` by default.
   */
  run: Partial<RqlRunDeps>;
  /** The gate of an agent's `run_rql` (`scope.purpose`): `rqlAgentGate` by default. */
  agentGate: RqlGate;
  /** The gate of alert rules (`scope.purpose`): `rqlAlertGate` by default. */
  alertGate: RqlGate;
  /** The RQL version of this build. A test gives a later one to reach the path of older queries. */
  rqlVersion: number;
  /** The project's trace properties: read only for a text that names `properties`. */
  properties: (projectId: string) => Promise<RqlProperties>;
}

type SqlRunner = NonNullable<typeof metricSeams.sql>;

metricSeams.sql = sqlQueryRunner();

/** The runner of kind `sql`. */
export function sqlQueryRunner(deps: Partial<SqlQueryDeps> = {}): SqlRunner {
  const {
    run = {},
    rqlVersion = RQL_VERSION,
    agentGate = rqlAgentGate,
    alertGate = rqlAlertGate,
    properties = (projectId) => loadStoredPropertyNames(projectId),
  } = deps;
  return (projectId, query, scope) =>
    runSqlQuery(projectId, query, scope, { run, rqlVersion, agentGate, alertGate, properties });
}

async function runSqlQuery(
  projectId: string,
  query: SqlQuery,
  scope: QueryScope,
  { run, rqlVersion, agentGate, alertGate, properties }: SqlQueryDeps,
): Promise<SqlResult> {
  if (query.rqlVersion > rqlVersion)
    throw new QueryError(
      `The query is written in RQL version ${query.rqlVersion}, and this server knows version ${rqlVersion} at most.`,
      { code: "rql_version", fix: `Write the query in RQL version ${rqlVersion}.` },
    );
  const alert = scope.purpose === "alert";
  const path = {
    alert: { gate: alertGate, max: RQL_LIMITS.parallelAlertQueriesPerProject },
    agent: { gate: agentGate, max: RQL_LIMITS.parallelQueriesPerProject },
    console: {
      gate: run.gate ?? rqlConsoleGate,
      max: RQL_LIMITS.parallelConsoleQueriesPerProject,
    },
  }[scope.purpose ?? "console"];
  // A place waits up to `gateWaitMs`, in order: a dashboard of more queries than the cap waits.
  const leave = await path.gate.wait(projectId, RQL_LIMITS.gateWaitMs);
  if (!leave) {
    const { code, message, fix } = busyError(path.max);
    throw new QueryError(message, { code, fix });
  }
  try {
    // A text that names no property costs no read of them.
    const named = /properties/i.test(query.text) ? await properties(projectId) : undefined;
    const compiled = compileRql(query.text, {
      ...(named ? { properties: named } : {}),
      now: scope.until,
      // The window of the page, by known time for an alert rule, as the metric form reads it.
      window: { from: scope.since, to: scope.until, ...(scope.by ? { by: scope.by } : {}) },
      // A console run reads the range of its page: up to `consoleMaxWindowDays`. An agent's
      // `run_rql` keeps the shorter window of RQL.
      console: scope.purpose !== "agent",
      // The page's filter keeps the rows whose trace matches, as it does for the other kinds.
      ...(scope.filter ? { filter: scope.filter } : {}),
    });
    if (!compiled.ok) {
      const { code, message, fix, at, property } = compiled.error;
      throw new QueryError(
        query.rqlVersion < rqlVersion
          ? `The query was written for RQL version ${query.rqlVersion}, and no longer compiles in version ${rqlVersion}: ${message}`
          : message,
        // Where in the text: the field marks it.
        {
          code,
          fix,
          ...(at ? { at: { start: at.start, end: at.end } } : {}),
          ...(property ? { property } : {}),
        },
      );
    }
    const timeoutMs = alert
      ? Math.min(run.timeoutMs ?? RQL_LIMITS.alertTimeoutMs, RQL_LIMITS.alertTimeoutMs)
      : run.timeoutMs;
    const result = await runRql(
      compiled,
      { projectId },
      { ...run, gate: placeHeld, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    );
    if (!result.ok) {
      const { code, message, fix } = result.error;
      throw new QueryError(message, { code, fix });
    }
    return { kind: "sql", columns: result.columns, rows: result.rows, truncated: result.truncated };
  } finally {
    leave();
  }
}
