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
  run(): Promise<Record<string, unknown> | number | void>;
};

export type Registration = {
  jobs?: Record<string, JobHandler>;
  drainSteps?: DrainStep[];
};

export type RegistryPort = {
  registrations(): Registration[];
};
