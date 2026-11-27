import type { RqlExecutor } from "../ports/executor";
import { RqlSetupError } from "../ports/executor";
import type { RqlType } from "./catalog";
import type { RqlCompileResult } from "./compile";
import type { RqlGate } from "./gate";
import { RQL_LIMITS } from "./limits";

/**
 * Runs a compiled query on the executor: the gate of the project first, then one row more than
 * the limit (only the parameter at `limitParam` changes), so a result the cap cut is marked
 * `truncated`. Database errors become RQL errors with a code, a message and a fix, as the
 * compiler's errors.
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
      /** The query had more rows than its limit: `rows` holds the first `limit`. */
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
    });
    return {
      ok: true,
      columns: compiled.columns,
      rows: rows.slice(0, compiled.limit).map((row) => normalizeRow(row, compiled.columns)),
      truncated: rows.length > compiled.limit,
    };
  } catch (error) {
    const mapped = runError(error, context.timeoutMs);
    if (!mapped) throw error;
    return { ok: false, error: mapped };
  } finally {
    leave();
  }
}

function busyError(): RqlRunError {
  const max = RQL_LIMITS.parallelQueriesPerProject;
  return {
    code: "rql_busy",
    message: `This project already runs ${max} queries at the same time.`,
    fix: "Wait until one of them ends, then run the query again.",
  };
}

/** The pg driver gives numeric and bigint values as strings, and timestamps as Dates. */
function normalizeRow(row: unknown[], columns: RqlCompiled["columns"]): unknown[] {
  return row.map((value, i) => normalizeValue(value, columns[i]?.type));
}

function normalizeValue(value: unknown, type: RqlType | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (type === "integer" || type === "number") {
    if (typeof value === "string" || typeof value === "bigint") return Number(value);
  }
  return value;
}

/** The RQL error of a database error, or `undefined` for an error that is not one (a bug). */
function runError(error: unknown, timeoutMs: number): RqlRunError | undefined {
  if (error instanceof RqlSetupError) {
    return {
      code: "rql_unavailable",
      message: "RQL is not set up on this database: the read-only role or its connection failed.",
      fix: "Ask the operator to run the migrations as a user that can CREATE ROLE, and to grant ratel_rql to the user of RQL_DATABASE_URL.",
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
