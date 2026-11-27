-- The alert history keeps 90 days (F446-5): this index lets the tick's prune read the oldest rows
-- first. The migration runs in a transaction, so its CREATE INDEX cannot be CONCURRENTLY and would
-- block the evaluator's inserts while it builds. alert_events is new and small; on a large table,
-- run this on production before the deploy, outside a transaction (psql autocommit):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "alert_events_at_idx" ON "alert_events" USING btree ("at");
-- The CREATE INDEX IF NOT EXISTS below is then a no-op.
CREATE INDEX IF NOT EXISTS "alert_events_at_idx" ON "alert_events" USING btree ("at");
