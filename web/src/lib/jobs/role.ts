import { type Config, getConfig } from "@/config";

/**
 * What this process does with background work (docs/design/background-worker.md):
 * - `all` (the default, today's behaviour): serves requests and also runs jobs,
 *   after its responses and on the cron tick.
 * - `api`: serves requests and only queues jobs. Customers' requests never wait
 *   behind analysis.
 * - `worker`: runs the job loop and the scheduled sweeps; serves no customer
 *   traffic (no load balancer in front of it). With the ingest queue on it also
 *   persists queued ingest batches (its ingest lane).
 * - `ingest`: serves the ingest routes and only queues, like `api`, but never
 *   migrates: a deployment routes `/api/v1/traces`, `/logs` and `/events` to it.
 * - `persist`: runs only the ingest lane (RTL-314): it persists queued batches
 *   and nothing else, so Cloud can scale it on the queue's depth.
 */
export type AppRole = "all" | "api" | "worker" | "ingest" | "persist";

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

/** Whether this process persists queued ingest batches right after a request's response. */
export function persistsIngestAfterResponse(config: Pick<Config, "app"> = getConfig()): boolean {
  return appRole(config) === "all";
}

/** Whether this process runs the ingest lane: a loop persisting queued ingest batches. */
export function runsIngestLane(config: Pick<Config, "app"> = getConfig()): boolean {
  const role = appRole(config);
  return role === "worker" || role === "persist";
}
