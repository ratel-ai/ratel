type Environment = Readonly<Record<string, string | undefined>>;

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

export function appRole(env: Environment = process.env): AppRole {
  const raw = env.APP_ROLE?.trim().toLowerCase();
  return raw === "api" || raw === "worker" ? raw : "all";
}

/**
 * Whether an accepted import is handed to the worker as a `run_import` job
 * (RC-40) instead of running in the request's task. Off until
 * IMPORTS_RUN_IN_WORKER=1, set together with APP_ROLE=api once the worker runs
 * in that environment: before then every task that drains must know the job
 * kind, or an older one mid-deploy would claim it and fail it.
 */
export function importsRunInWorker(env: Environment = process.env): boolean {
  return env.IMPORTS_RUN_IN_WORKER?.trim() === "1";
}

/** Whether this process runs jobs right after a request's response. */
export function runsJobsAfterResponse(env: Environment = process.env): boolean {
  return appRole(env) === "all";
}
