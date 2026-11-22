-- RC-395: the chosen option's own fingerprint on each cached decision, so a
-- topic or task decision can be carried to a new option set that still holds
-- that option unchanged. Additive and nullable: older rows simply carry nothing.
ALTER TABLE "trace_workflow_verdicts" ADD COLUMN IF NOT EXISTS "option_print" text;
