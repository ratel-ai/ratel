/**
 * The L1 queries in one namespace. Upstream kept every query in one file; here each module owns
 * its own `queries.ts`, and this barrel exists so a caller that imports from the old hub keeps
 * one import for the platform-level functions. Higher layers are never re-exported from here.
 */
export * from "@/lib/platform/db/errors";
export * from "@/lib/platform/identity/queries";
export * from "@/lib/platform/projects/queries";
