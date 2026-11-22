/**
 * The shapes the Agent health page state reads about imported runs (a backfill from another
 * observability product). The importer is an edition's (`EditionUi.HealthImports`); without one
 * the page passes `imports: []` and these states stay typed but unreached. Declared here so the
 * state machine stays a plain copy of upstream's.
 */

/** The id of the product an import read from; the edition names it. */
export type ImportSource = string;

/** One import as the page state reads it: upstream's summary shape, declared by the contract. */
export type { ImportSummary } from "@/lib/contracts/imported-runs";

/** How an import's source is named in copy without an edition's names: its id, capitalized. */
export const SOURCE_LABEL: Record<ImportSource, string> = new Proxy(
  {},
  {
    get: (_labels, source) =>
      typeof source === "string" ? source.charAt(0).toUpperCase() + source.slice(1) : "",
  },
);
