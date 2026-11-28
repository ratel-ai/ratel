import type { RqlExecutor } from "../ports/executor";
import { RqlBusyError, RqlSetupError } from "../ports/executor";
import type { RqlType } from "./catalog";
import type { RqlCompileResult } from "./compile";
import type { RqlGate } from "./gate";
import { RQL_LIMITS } from "./limits";
import { shapeRows } from "./result";

/**
 * Runs a compiled query on the executor: the gate of the project first, then one row more than
 * the limit (only the parameter at `limitParam` changes), so a result that a cap of Ratel cut (the
 * default limit, or `maxLimit`, which a LIMIT of that size or more reads as) is marked
 * `truncated`. Rows past the query's own LIMIT under `maxLimit` are no cut: it asked for that many. The rows are cut to the cell and byte caps of `RQL_LIMITS` (`result.ts`), and a
 * cut marks the result `truncated` too. Database errors become RQL errors with a code, a message
 * and a fix, as the compiler's errors.
 */

export type RqlCompiled = Extract<RqlCompileResult, { ok: true }>;

export type RqlRunErrorCode =
  | "rql_busy"
  | "rql_timeout"
  | "rql_permission_denied"
  | "rql_read_only"
  | "rql_unavailable"
  | "rql_query_failed";

export interface RqlRunError {
  code: RqlRunErrorCode;
  message: string;
  fix: string;
}

/**
 * `rows` are arrays in the order of `columns`. An integer or a number is a JS number, a
 * timestamp is an ISO 8601 string, a list is an array, `attributes` is the JSON object.
 */
export type RqlRunResult =
  | {
      ok: true;
      columns: { name: string; type: RqlType }[];
      rows: unknown[][];
      /**
       * A cap of Ratel cut the result: the query had more rows than the default limit or
       * `maxLimit`, a cell was cut to `maxCellChars`, or the rows stopped at `maxResultBytes`.
       */
      truncated: boolean;
    }
  | { ok: false; error: RqlRunError };

export interface RqlRunContext {
  projectId: string;
  executor: RqlExecutor;
  gate: RqlGate;
  timeoutMs: number;
}

/** Postgres SQLSTATEs the runner names. */
const QUERY_CANCELED = "57014";
const INSUFFICIENT_PRIVILEGE = "42501";
const READ_ONLY_SQL_TRANSACTION = "25006";

export async function executeCompiled(
  compiled: RqlCompiled,
  context: RqlRunContext,
): Promise<RqlRunResult> {
  const leave = context.gate.enter(context.projectId);
  if (!leave) return { ok: false, error: busyError() };
  try {
    const rows = await context.executor.execute({
      projectId: context.projectId,
      sql: compiled.sql,
      params: compiled.params.map((value, i) =>
        i === compiled.limitParam ? compiled.limit + 1 : value,
      ),
      timeoutMs: context.timeoutMs,
      maxBytes: RQL_LIMITS.maxResultBytes,
    });
    const shaped = shapeRows(
      rows,
      compiled.columns.map(({ type }) => type),
      { limit: compiled.limit, capped: !compiled.ownLimit },
    );
    return { ok: true, columns: compiled.columns, ...shaped };
  } catch (error) {
    const mapped = runError(error, context.timeoutMs);
    if (!mapped) throw error;
    return { ok: false, error: mapped };
  } finally {
    leave();
  }
}

/** The error of a project that runs its most queries already: `max` is the cap of the gate it asked. */
export function busyError(max: number = RQL_LIMITS.parallelQueriesPerProject): RqlRunError {
  return {
    code: "rql_busy",
    message: `This project already runs ${max} ${max === 1 ? "query" : "queries"} at the same time.`,
    fix: "Wait until one of them ends, then run the query again.",
  };
}

/** The RQL error of a database error, or `undefined` for an error that is not one (a bug). */
function runError(error: unknown, timeoutMs: number): RqlRunError | undefined {
  if (error instanceof RqlBusyError) {
    return {
      code: "rql_busy",
      message: "Every RQL connection of this server is in use.",
      fix: "Wait a few seconds, then run the query again.",
    };
  }
  if (error instanceof RqlSetupError) {
    return {
      code: "rql_unavailable",
      message: "RQL is not set up on this database: the read-only role or its connection failed.",
      fix: "Ask the operator to create the role ratel_rql as a superuser and to run GRANT ratel_rql TO <the user of RQL_DATABASE_URL, else DATABASE_URL> (the RQL README, Setup of the role).",
    };
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return undefined;
  if (code === QUERY_CANCELED) {
    return {
      code: "rql_timeout",
      message: `The query ran longer than ${timeoutMs / 1000} seconds and was stopped.`,
      fix: "Read less: give a shorter window, add a WHERE filter, or group by fewer columns.",
    };
  }
  if (code === INSUFFICIENT_PRIVILEGE) {
    return {
      code: "rql_permission_denied",
      message: "The query read something outside the rql views.",
      fix: "Read only the tables events, traces, scores, sessions and users.",
    };
  }
  if (code === READ_ONLY_SQL_TRANSACTION) {
    return {
      code: "rql_read_only",
      message: "RQL is read-only: the query tried to write.",
      fix: "Write one SELECT statement.",
    };
  }
  return {
    code: "rql_query_failed",
    message: `The database refused the query: ${error instanceof Error ? error.message : String(error)}`,
    fix: "Change the query as the message says, or call describe_rql_schema for the columns and functions.",
  };
}
