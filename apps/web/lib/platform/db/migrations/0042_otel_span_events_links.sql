-- AOBS-7: a span's events (a compaction, a permission decision, a hook, a human wait) and its links
-- (a background task, a message from another chat), content-free and bounded. Null on every earlier
-- row. Nullable with no default: no table rewrite.
-- IF NOT EXISTS: a database migrated by ratel-cloud already has these (its 0110), so this is a no-op there.
ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "events" jsonb;--> statement-breakpoint
ALTER TABLE "otel_spans" ADD COLUMN IF NOT EXISTS "links" jsonb;
