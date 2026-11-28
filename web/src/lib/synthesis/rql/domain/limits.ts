/**
 * The bounds of every RQL query. The compiler and the runner apply them, and `describeRqlSchema`
 * gives them to the agent. Change a value here only: the tests and the description read it from
 * this file.
 */
export const RQL_LIMITS = Object.freeze({
  /** The window of a query that gives none: the last 24 hours before `now`. */
  defaultWindowHours: 24,
  /** The longest window a query can ask for. */
  maxWindowDays: 30,
  /** The rows of a query that has no LIMIT. */
  defaultLimit: 100,
  /** The most rows a query can give. A larger LIMIT is lowered to this value. */
  maxLimit: 1000,
  /** The longest query text, in characters. The compiler refuses a longer text before the parse. */
  maxTextChars: 4000,
  /** The most output columns of a query. Each column of an expanded `*` counts. */
  maxSelectItems: 50,
  /** The most items of one list (IN, GROUP BY, ORDER BY, function arguments). */
  maxListItems: 100,
  /** The longest output column name (an alias), in characters. */
  maxAliasChars: 64,
  /** The deepest nesting of an expression. */
  maxExpressionDepth: 200,
  /** The longest text of one cell, in characters. A longer cell is cut, and the result is marked truncated. */
  maxCellChars: 2000,
  /** The most bytes of the rows of one result, as JSON. The runner stops there and marks the result truncated. */
  maxResultBytes: 1_000_000,
  /** Postgres stops a query that runs longer (`statement_timeout`). */
  timeoutMs: 10_000,
  /** The queries one project can run at the same time. One more waits for a place, then is refused. */
  parallelQueriesPerProject: 2,
  /** The alert queries one project can run at the same time, on their own gate. */
  parallelAlertQueriesPerProject: 1,
  /** How long a query waits for a place of its project before `rql_busy`. */
  gateWaitMs: 5_000,
  /**
   * The timeout of an alert rule's query. Alert queries take a gate of their own, one per project
   * at a time, so a dashboard never makes a rule fail, and a slow rule holds its tick for this long.
   */
  alertTimeoutMs: 2_000,
});

export type RqlLimits = typeof RQL_LIMITS;
