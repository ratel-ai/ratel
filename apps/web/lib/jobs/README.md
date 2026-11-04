# `lib/jobs` (L1)

The background machinery: a durable queue in the `jobs` table, a runner, and the drain that runs
every minute. It knows the registry port and nothing else: each module contributes its job
handlers and drain steps through its own `register.ts`, collected by `lib/composition/registry.ts`.

| Path | Holds |
|---|---|
| `schema.ts`, `queries.ts` | the `jobs` table with its coalescing indexes; enqueue, claim (`FOR UPDATE SKIP LOCKED`, fair across projects: a per-project running cap, `JOBS_RUNNING_PER_PROJECT`, default 1, and the projects a drain just served last), mark, reap, poll (`getJobForProject` answers `GET /api/v1/jobs/[id]` for a project key) |
| `policy.ts` | each kind's claim tier (work someone waits on, fresh data, sweeps) and expected run time |
| `runner.ts` | `drainJobs`: claim, run the kind's handler, record the outcome and a `job_finished` line (`job_over_budget` past the kind's budget); one poisoned job never stalls the queue |
| `store.ts` | `drainProjectJobs`: the runner wired to the database and the registered handlers, after reaping zombies |
| `observability.ts` | typed background events and exception reports through the telemetry shim |
| `route-helpers.ts` | `enqueueForProjectId` and `scheduleProjectDrain`: enqueue, then drain after the HTTP response with Next's `after()` |
| `role.ts` | `APP_ROLE`: `all` (the default) also drains after a response; `api` only queues |
| `drain.ts` | one cron tick: `before` steps, the drain, `after` steps (retention-only ones gated by `DATA_RETENTION_ENABLED=1`); `GET /api/cron/drain` |
| `scheduler.ts` | the in-process timer the open-source edition runs the tick with (`RATEL_CRON=inprocess`, the OSS default); Cloud uses an external caller |

Three ways a job runs: right after the request that enqueued it, on the next tick, or on the
next external call of the drain route. All three meet in `drainProjectJobs`, and the atomic claim
keeps them from picking the same job.
