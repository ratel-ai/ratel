import type { Organization } from "@/lib/contracts/session";

/**
 * The shape of a decoded OTLP span (`lib/ingest/otlp/types.ts`), declared here so the edition
 * can hand spans to the core without importing it. Structural: the core's adapter passes these
 * to its own ingest, so typecheck fails if the two drift.
 */
export type SpanAttrValue =
  | string
  | number
  | boolean
  | null
  | SpanAttrValue[]
  | { [key: string]: SpanAttrValue };

export type SpanAttrMap = Record<string, SpanAttrValue>;

export type ImportedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startUnixMs: number;
  endUnixMs: number;
  attributes: SpanAttrMap;
  events: { name: string; timeUnixMs: number; attributes: SpanAttrMap }[];
  statusCode: number;
  resourceAttributes: SpanAttrMap;
  scopeName: string | null;
};

/** `events`: the LLM-call rows failed. `derived`: a batch of only ledger rows failed. */
export type ImportedSpansResult =
  | { ok: true; accepted: number; calls: number }
  | { ok: false; stage: "events" | "derived" };

/** Where a storing failure is reported: the edition's own logger and error tracker. */
export type ImportReport = {
  logError: (message: string, err?: unknown, fields?: Record<string, unknown>) => void;
  captureFailure: (error: unknown) => void;
};

/**
 * Runs read from another observability product (Cloud's Agent health import), stored as live
 * telemetry is. Only the core writes its ingest tables and job queue, so it implements this and
 * lends it to the edition through `CompositionPorts.connect`.
 */
export type ImportedRunsPort = {
  /**
   * Store spans under a project like the OTLP route does: no monthly allowance spent, no fold
   * kick (the drain's safety net folds imported runs paced), the turn build queued.
   */
  persist(
    projectId: string,
    organization: Organization,
    spans: ImportedSpan[],
    report: ImportReport,
  ): Promise<ImportedSpansResult>;
  /** Ask for a reading once the turn build catches up; drains now when this process runs jobs. */
  requestReading(projectId: string): Promise<void>;
  enqueueJob(projectId: string, kind: string, payload: unknown): Promise<{ id: string }>;
  /** Run the project's queued jobs after the response, where this process runs jobs. */
  scheduleDrain(projectId: string): void;
  /**
   * Name the source ids the importer stores its runs under (the `service.name` of its spans),
   * as exact strings, from `connect`. A turn under one of them is history read once: it closes
   * as soon as it is built, and Agent health counts it as imported. The core knows the ids it
   * can name; any other id is live telemetry until an importer registers it, whatever it ends
   * in. Optional in the type so an edition's stand-ins keep compiling; the core always supplies
   * it. ratel-platform registers its ids when its importer lands: it has none yet, so this
   * addition needs no paired change there.
   */
  registerSourceIds?(ids: readonly string[]): void;
};

/** One import as the Agent health page reads it (Cloud's `ImportSummary`). */
export type ImportSummary = {
  id: string;
  /** The id of the product read from; the edition names it (`EditionUi.HealthImports.sourceLabel`). */
  source: string;
  /** `waiting`: a relay import whose command has not connected yet. `received`: saved, waiting on us. */
  status: "waiting" | "running" | "completed" | "received" | "failed";
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
};

/** A window the page offers (`readings/trace-signals/view.ts`). */
export type ImportWindowOption = { days: number; label: string; locked: boolean };
