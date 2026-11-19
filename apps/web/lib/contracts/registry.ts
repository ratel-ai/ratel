import type { z } from "zod";

/**
 * What a module contributes to the background machinery: job handlers by kind, and steps the
 * cron drain runs before or after it claims queued jobs. Core modules export a `register.ts`
 * with this shape; the composition root collects them, and the Cloud edition adds its own
 * through this port. `jobs/` knows the registry and nothing else (ADR-0030).
 */
export type JobRecord = {
  id: string;
  projectId: string;
  kind: string;
  payload: unknown;
};

export type JobHandler = (job: JobRecord) => Promise<unknown>;

export type DrainStep = {
  /** Reported under this key in the drain summary. */
  name: string;
  /** `before`: enqueue work the drain then runs. `after`: sweeps and pruning. */
  phase: "before" | "after";
  /** Runs only when the operator has turned retention deletion on. */
  retentionOnly?: boolean;
  /**
   * The step's result lands in the drain summary under `name`, and its numeric and boolean
   * fields (or a bare number, under `name`) land flat on the `cron_drain_completed` heartbeat;
   * keep the upstream field names so dashboards keep joining. A step that did work emits its
   * own typed event (`trace_summaries_refreshed`, `match_quality_runs_enqueued`, ...); the
   * drain emits only the heartbeat. A throw is caught, reported under `name`, and never
   * stops the tick.
   */
  run(): Promise<Record<string, unknown> | number | undefined>;
};

/** The loop stage an MCP tool is listed under, or null for a tool outside the loop. */
export type McpToolStage = "monitor" | "insights" | "improve" | "ship" | null;

/** What an edition's MCP tool is called with: the project dispatch authorized, and its organization. */
export type EditionMcpContext = {
  projectId: string;
  organizationId: string | null;
  /** The core's `not_found` answer ("No <entity> found."): throw it, as a core tool does. */
  notFound(entity: string): Error;
};

/** An edition MCP tool's answer: JSON-serializable data, already summarized and capped. */
export type EditionMcpResult = {
  data: unknown;
  /** True when a row cap or truncation was applied anywhere in `data`. */
  truncated?: boolean;
  /** What to call next, for the agent. */
  hint?: string;
};

/**
 * An MCP tool an edition adds, over data only the edition has. Read-only by construction: the
 * core publishes it with `mutates: false`, so it is never a write a client must confirm. The
 * core adds `projectId` to `params` and resolves it as for its own tools, and refuses at startup
 * a tool whose id is taken or not snake_case, whose description is under 21 or over 400
 * characters, whose params declare their own `projectId`, whose keyword is a question a core
 * tool owns, or whose `after` names no core tool.
 */
export type EditionMcpOperation<Params extends z.ZodObject = z.ZodObject> = {
  /** snake_case, unique across the MCP server. */
  id: string;
  title: string;
  /** One or two keyword-rich sentences: the whole routing table a client sees. */
  description: string;
  /** Extra discovery terms that do not belong in the description. */
  keywords?: readonly string[];
  /** `organization` for a tool about the project's organization (its wallets, its plan). */
  scope: "project" | "organization";
  /** Published on the tool as `_meta["sh.ratel/stage"]` when not null. */
  stage: McpToolStage;
  /** The core tool this one is listed after; absent lists it last. */
  after?: string;
  /** The tool's own params, without `projectId`. */
  params: Params;
  execute(context: EditionMcpContext, params: z.output<Params>): Promise<EditionMcpResult>;
};

export type Registration = {
  jobs?: Record<string, JobHandler>;
  drainSteps?: DrainStep[];
  /** MCP tools the edition adds (`lib/mcp/operations/edition.ts`). The open-source edition has none. */
  mcpOperations?: EditionMcpOperation[];
  /**
   * Ids of `running` jobs this module knows are still alive however long they have run (a job
   * with its own heartbeat, such as a long import): the stale-job reaper spares them. Read before
   * each reap; a failed read spares nothing.
   */
  liveJobs?: () => Promise<readonly string[]>;
};

export type RegistryPort = {
  registrations(): Registration[];
};
