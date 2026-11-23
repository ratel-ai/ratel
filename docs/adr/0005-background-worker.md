# 5. Background work runs in a worker process, chosen by `APP_ROLE`

## Status

Accepted

## Context

Analysis jobs call models for minutes at a time. When they run in the process that serves
requests, they share its CPU, memory and database connections, and one busy project slows
every request. A self-hoster must still be able to run one container, and `pnpm dev` must
stay one command.

## Decision

**One image, three roles.** `APP_ROLE` picks what a process does with background work. Unset
or unknown means `all`.

| `APP_ROLE` | After a response | Minute tick | Migrates on boot |
|---|---|---|---|
| `all` (default) | drains the project's jobs | the in-process timer, or an external caller with `RATEL_CRON=external` | yes |
| `api` | only queues | none | yes |
| `worker` | serves no traffic | the worker loop | never |

**The worker starts from instrumentation, in the same Next server.** The image is a Next
standalone build, so a separate entry script would need a second bundle of every job handler.
The server listens on a port nobody publishes, which is also its health check.

**The worker is its own clock.** Its loop runs one step at a time: the cron tick every 60 s,
a drain otherwise, and a 3 s wait when a drain found nothing. On an `api` process,
`GET /api/cron/drain` answers 202 `{ ok: true, skipped: "worker" }`.

**Only the web process migrates.** The worker waits for a healthy web (`depends_on` in
`docker-compose.yml`).

**A stop waits for the step in flight.** With `NEXT_MANUAL_SIG_HANDLE=true` the worker handles
SIGTERM: it stops the loop, lets the running step finish, flushes its telemetry and exits 0. A
second signal exits at once. A job cut short stays `running` until the reaper fails it after
ten minutes, and the tick queues its work again.

`docker-compose.yml` runs `web` as `api` next to a `worker`. The image run by hand and
`pnpm dev` stay `all`.

## Consequences

- In the compose deployment, a request never shares its process with analysis. Analysis can
  trail the data by seconds to minutes.
- The worker costs one idle Next server's memory and a second database pool.
- A job that runs longer than ten minutes is reaped while alive. Such a job needs a heartbeat
  or a longer window for its kind.
- Only the log lines (`job_finished`, `cron_drain_completed`) show that the loop is alive.
