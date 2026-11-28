/**
 * Runs compiled SQL for one project on the read-only path: a READ ONLY transaction as the role
 * `ratel_rql`, with the project setting the `rql` views filter on and a local
 * `statement_timeout`. It gives the rows as arrays, in the order of the output columns.
 *
 * A database error is thrown as it is (its SQLSTATE in `code`). An error before the query runs
 * (the role or the setting) is thrown as an `RqlSetupError`, so the runner can tell "RQL is not
 * set up" from "this query failed". A pool with no free connection in its connect timeout throws
 * an `RqlBusyError`: RQL is set up, and busy.
 *
 * The executor stops reading rows once their size (`shapedRowBytes`) passes `maxBytes`: the rows
 * it gives then are enough for the runner to see the byte cap and mark the result truncated.
 */
export interface RqlExecutor {
  execute(run: RqlExecution): Promise<unknown[][]>;
}

export interface RqlExecution {
  projectId: string;
  sql: string;
  params: readonly unknown[];
  timeoutMs: number;
  /** The executor reads no more rows once the rows it holds pass this size. */
  maxBytes: number;
}

/** The read-only transaction could not be opened as `ratel_rql` for the project. */
export class RqlSetupError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RqlSetupError";
  }
}

/** No connection of the RQL pool came free within its connect timeout. */
export class RqlBusyError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RqlBusyError";
  }
}
