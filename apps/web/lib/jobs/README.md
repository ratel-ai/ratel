# `lib/jobs` (L1)

The background machinery: a durable queue in the `jobs` table, a runner, and the drain that runs
every minute. It knows the registry port and nothing else: each module contributes its job
handlers and drain steps through its own `register.ts`, collected by `lib/composition/registry.ts`.

| Path | Holds |
|---|---|
| `schema.ts`, `queries.ts` | the `jobs` table with its coalescing indexes (one queued job of a kind per project; `draft_fix` one pending job per fix, `payload->>'fixId'`); enqueue, claim (`FOR UPDATE SKIP LOCKED`, fair across projects: a per-project running cap, `JOBS_RUNNING_PER_PROJECT`, default 1, and the projects a drain just served last), mark, reap, poll (`getJobForProject` answers `GET /api/v1/jobs/[id]` for a project key) |
| `project-context.ts` | `inProjectLogContext`: the jobs that call models (labelling, topics, intents, match quality, fix drafts, What-if, task simulations) run in their project's log context and as one agent run each (`jobAsk`: the kind, the project and the payload). Owned: upstream keeps it in its job hub; each module's `register.ts` wraps its own |
| `policy.ts` | each kind's claim tier (work someone waits on, fresh data, sweeps) and expected run time |
| `kinds.ts` | `RUN_IMPORT_JOB`, the kind the worker's import lane takes (RC-40): the analysis lane and the cron drain take every other kind, and a running import does not count against its project's cap |
| `runner.ts` | `drainJobs`: claim, run the kind's handler, record the outcome and a `job_finished` line (`job_over_budget` past the kind's budget); one poisoned job never stalls the queue |
| `store.ts` | `drainProjectJobs`: the runner wired to the database and the registered handlers, after reaping zombies |
| `observability.ts` | typed background events and exception reports through the telemetry shim |
| `route-helpers.ts` | `enqueueForProjectId` and `scheduleProjectDrain`: enqueue, then drain after the HTTP response with Next's `after()` |
| `role.ts` | `APP_ROLE`: `all` (the default) also drains after a response; `api` only queues; `worker` runs the job loop |
| `boot-plan.ts` | what a process does at boot, from `APP_ROLE` and `RATEL_CRON`: whether it migrates, and who runs its tick |
| `drain.ts` | one cron tick: `before` steps, the drain, `after` steps (retention-only ones gated by `DATA_RETENTION_ENABLED=1`); `GET /api/cron/drain`, which an API-only process answers with 202 and no tick |
| `drain-observer.ts` | the drain's outcome in the logs for the deployment's Datadog drain monitors (owned port of upstream's `observeDrain`): `drain_started`, `drain_completed` with the age of the oldest queued job of tier 0 or 1 (`readOldestQueuedJobAgeMs`; tier 2 sweeps wait on purpose), `job_queue_lagging` past 10 minutes, `drain_failed`; the cron route and the worker's sweep both report through it. The worker's sweep also has upstream's watchdog (`timedDrain`): `drain_progress` after each finished job, `drain_timed_out` after `CRON_DRAIN_TIMEOUT_MS` (10 minutes by default, `0` turns it off) with no finished job, and `drain_skipped_hung` while two sweeps are unsettled, so a hung sweep never stops the analysis lane |
| `scheduler.ts` | the in-process timer an all-in-one process runs the tick with (`RATEL_CRON=inprocess`, the OSS default); Cloud uses an external caller |
| `worker.ts` | the worker's loop: one step at a time, the tick every 60 s, a drain otherwise, a 3 s wait when nothing is queued |
| `worker-start.ts` | the loop wired to `drainProjectJobs` (an analysis lane and an import lane) and `runDrainTick` (observed, `workerTick`), started once per process; once a day `reportTopQueries` logs the database's most expensive statements as `db_top_query` and resets the counts; on SIGTERM it finishes the step in flight, flushes the self-telemetry when that is on, then exits |

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
