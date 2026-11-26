/**
 * The bounds of every RQL query. The compiler applies them, and `describeRqlSchema` gives them to
 * the agent. Change a value here only: the tests and the description read it from this file.
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
  /** Postgres stops a query that runs longer (`statement_timeout`). */
  timeoutMs: 10_000,
  /** The queries one project can run at the same time. The runner refuses one more. */
  parallelQueriesPerProject: 4,
});

export type RqlLimits = typeof RQL_LIMITS;
