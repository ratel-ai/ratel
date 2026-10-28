/**
 * Every L1 table in one namespace, for callers that import the schema wholesale
 * (`import * as schema from "@/lib/platform/db/tables"`). Higher layers own their own
 * fragments and are never re-exported from here; a module that needs `trace_events` imports
 * `@/lib/ingest/schema`. drizzle-kit reads the fragments directly (`drizzle.config.ts`), so
 * this file is for code, not for migrations.
 */
export * from "@/lib/jobs/schema";
export * from "@/lib/platform/identity/schema";
export * from "@/lib/platform/projects/schema";
