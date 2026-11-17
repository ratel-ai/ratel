-- The Sessions list (RC-311): a run's turn by its `otlp:<trace id>` key without its
-- session. trace_turns is small next to the span tables; on a large environment
-- build it CONCURRENTLY out-of-band first and this IF NOT EXISTS is a no-op.
CREATE INDEX IF NOT EXISTS "trace_turns_project_turn_key_idx" ON "trace_turns" USING btree ("project_id","turn_key");
