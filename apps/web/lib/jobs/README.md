# `lib/jobs` (L1)

The background machinery: a durable queue in the `jobs` table, a runner, and the drain that runs
every minute. It knows the registry port and nothing else: each module contributes its job
handlers and drain steps through its own `register.ts`, collected by `lib/composition/registry.ts`.

| Path | Holds |
|---|---|
| `schema.ts`, `queries.ts` | the `jobs` table with its coalescing indexes (one queued job of a kind per project; `draft_fix` one pending job per fix, `payload->>'fixId'`); enqueue, claim (`FOR UPDATE SKIP LOCKED`, fair across projects: a per-project running cap, `JOBS_RUNNING_PER_PROJECT`, default 1, and the projects a drain just served last), mark, reap, poll (`getJobForProject` answers `GET /api/v1/jobs/[id]` for a project key) |
| `policy.ts` | each kind's claim tier (work someone waits on, fresh data, sweeps) and expected run time |
| `runner.ts` | `drainJobs`: claim, run the kind's handler, record the outcome and a `job_finished` line (`job_over_budget` past the kind's budget); one poisoned job never stalls the queue |
| `store.ts` | `drainProjectJobs`: the runner wired to the database and the registered handlers, after reaping zombies |
| `observability.ts` | typed background events and exception reports through the telemetry shim |
| `route-helpers.ts` | `enqueueForProjectId` and `scheduleProjectDrain`: enqueue, then drain after the HTTP response with Next's `after()` |
| `role.ts` | `APP_ROLE`: `all` (the default) also drains after a response; `api` only queues; `worker` runs the job loop |
| `boot-plan.ts` | what a process does at boot, from `APP_ROLE` and `RATEL_CRON`: whether it migrates, and who runs its tick |
| `drain.ts` | one cron tick: `before` steps, the drain, `after` steps (retention-only ones gated by `DATA_RETENTION_ENABLED=1`); `GET /api/cron/drain`, which an API-only process answers with 202 and no tick |
| `scheduler.ts` | the in-process timer an all-in-one process runs the tick with (`RATEL_CRON=inprocess`, the OSS default); Cloud uses an external caller |
| `worker.ts` | the worker's loop: one step at a time, the tick every 60 s, a drain otherwise, a 3 s wait when nothing is queued |
| `worker-start.ts` | the loop wired to `drainProjectJobs` and `runDrainTick`, started once per process; on SIGTERM it finishes the step in flight, then exits |

## Roles

One image, three roles ([ADR-0031](../../../../docs/adr/0031-platform-background-worker.md)):

| `APP_ROLE` | After a response | Minute tick | `GET /api/cron/drain` | Migrates |
|---|---|---|---|---|
| `all` (default; `pnpm dev`, one container) | drains | `scheduler.ts`, or the caller with `RATEL_CRON=external` | runs a tick | yes |
| `api` (`web` in `docker-compose.yml`) | only queues | none | 202, skipped | yes |
| `worker` | serves no traffic | `worker.ts` | runs a tick | never |

Every path meets in `drainProjectJobs`, and the atomic claim keeps two processes from picking
the same job. The worker needs `NEXT_MANUAL_SIG_HANDLE=true` to stop cleanly: without it Next
exits on SIGTERM before the step in flight finishes. A job cut short stays `running` until the
reaper fails it (`STALE_JOB_MS`, ten minutes), and holds its project's other jobs until then.
