import { type Config, getConfig } from "@/config";

/**
 * What this process does with background work (docs/design/background-worker.md):
 * - `all` (the default, today's behaviour): serves requests and also runs jobs,
 *   after its responses and on the cron tick.
 * - `api`: serves requests and only queues jobs. Customers' requests never wait
 *   behind analysis.
 * - `worker`: runs the job loop and the scheduled sweeps; serves no customer
 *   traffic (no load balancer in front of it).
 */
export type AppRole = "all" | "api" | "worker";

/** `app.role` (APP_ROLE). */
export function appRole(config: Pick<Config, "app"> = getConfig()): AppRole {
  return config.app.role;
}

/**
 * Whether an accepted import is handed to the worker as a `run_import` job
 * (RC-40) instead of running in the request's task. Off until
 * `jobs.importsRunInWorker` (IMPORTS_RUN_IN_WORKER=1), set together with APP_ROLE=api once the worker runs
 * in that environment: before then every task that drains must know the job
 * kind, or an older one mid-deploy would claim it and fail it.
 */
export function importsRunInWorker(config: Pick<Config, "jobs"> = getConfig()): boolean {
  return config.jobs.importsRunInWorker;
}

/** Whether this process runs jobs right after a request's response. */
export function runsJobsAfterResponse(config: Pick<Config, "app"> = getConfig()): boolean {
  return appRole(config) === "all";
}

/**
 * Whether this process reads the ingest queue (ADR-0009): the one that runs background work, when
 * a queue is configured. An API-only process publishes and never consumes.
 */
export function consumesIngestQueue(config: Pick<Config, "app" | "ingest"> = getConfig()): boolean {
  return config.ingest.queue !== "direct" && appRole(config) !== "api";
}
