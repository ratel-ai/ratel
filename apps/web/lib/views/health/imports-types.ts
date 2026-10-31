/**
 * The shapes the Agent health page state reads about imported runs (a backfill from another
 * observability product). The import feature itself is not part of the open-source edition;
 * the pages pass `imports: null` and these states stay typed but unreached. Declared here so the
 * state machine stays a plain copy of upstream's.
 */

/** The id of the product an import read from; this edition imports from none, so any string. */
export type ImportSource = string;

export type ImportStatus = "waiting" | "running" | "completed" | "received" | "failed";

/** One import as the page state reads it: upstream's summary shape, kept whole so copied tests type. */
export interface ImportSummary {
  id: string;
  source: ImportSource;
  status: ImportStatus;
  label: string;
  windowDays: number;
  itemsRead: number;
  runsImported: number;
  truncated: boolean;
  failure: string | null;
  failureDetail: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Read inside the tenant's own network by the import command. */
  relay: boolean;
}

/** How an import's source is named in copy: its id, capitalized, since no importer ships here. */
export const SOURCE_LABEL: Record<ImportSource, string> = new Proxy(
  {},
  {
    get: (_labels, source) =>
      typeof source === "string" ? source.charAt(0).toUpperCase() + source.slice(1) : "",
  },
);
