-- RC-585: scoped API keys. Additive only. Every existing key gets '{*}' (all
-- scopes, present and future), so each one keeps working exactly as before;
-- the old revision never reads either column, and a key it creates during the
-- roll gets the same Full default.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "scopes" text[] DEFAULT '{*}'::text[] NOT NULL;
--> statement-breakpoint
-- Optional per-key ceiling (requests a minute) for ingest-only keys shared by
-- many clients. Null = the default for the key's kind.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "rate_limit_per_minute" integer;
