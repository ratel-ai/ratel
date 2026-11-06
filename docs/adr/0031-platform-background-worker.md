# 31. Ratel Platform: background work runs in a worker process, chosen by `APP_ROLE`

Date: 2026-11-05

## Status

Accepted

Builds on [ADR-0030](0030-platform-oss-layered-core-and-cloud-sync.md): the loop is copied from
`ratel-cloud`; the wiring around it is owned here.

## Context

The platform ran every job inside the process that serves requests: right after the response
that queued it, and on a minute tick from an in-process timer. Analysis therefore shared CPU,
memory and database connections with ingest and the console, and the jobs to come (an eval
gate, the task loop, session replay's What-if) call models for minutes at a time. One busy
project's analysis could slow every request.

A self-hoster must still be able to run one container, and `pnpm dev` must stay one command.

## Decision

**One image, three roles.** `APP_ROLE` picks what a process does with background work; unset or
unknown means `all`.

| `APP_ROLE` | After a response | Minute tick | Migrates on boot |
|---|---|---|---|
| `all` (default) | drains the project's jobs | the in-process timer, or an external caller with `RATEL_CRON=external` | yes |
| `api` | only queues | none | yes |
| `worker` | serves no traffic | the worker loop | never |

**The worker starts from instrumentation, in the same server.** The image is a Next standalone
build with no source and no TypeScript runner; a separate entry script would need a second
bundle of every job handler, kept in step by hand. The Next server still listens inside the
worker, on a port nobody publishes, which is also its health check.

**The worker is its own clock.** Its loop runs one step at a time: the cron tick every 60 s (the
sweeps and safety nets), a drain otherwise, and a 3 s wait when a drain found nothing. It calls
the tick in process, so it needs no `CRON_SECRET`, and it sweeps whatever `RATEL_CRON` says:
that variable only decides who ticks for an `all` process. On an `api` process
`GET /api/cron/drain` answers 202 `{ ok: true, skipped: "worker" }`.

**One service migrates.** The web process applies migrations; the worker never does, whatever
`DATABASE_MIGRATE_ON_BOOT` says, and waits for a healthy web (`depends_on` in
`docker-compose.yml`). Started on its own against an empty schema, its steps fail, are logged,
and retry.

**A stop waits for the step in flight.** With `NEXT_MANUAL_SIG_HANDLE=true` the worker handles
SIGTERM itself: it stops the loop, lets the running step finish and exits 0; a second signal
exits at once. A job cut short anyway stays `running` until the reaper fails it after ten
minutes, and the tick's safety nets queue its work again.

`docker-compose.yml` runs `web` as `api` next to a `worker`. Everything else (the image run by
hand, `pnpm dev`) stays `all`.

## Consequences

- A request never shares its process with analysis in the compose deployment; analysis may
  trail the data by a few seconds to minutes, which the pages already say.
- The worker costs one idle Next server's memory and a second database pool.
- A job cut short holds its project's other jobs until it is reaped (the per-project running
  cap). A job that runs past ten minutes would be reaped while alive: the first such job needs a
  heartbeat or a longer window for its kind, and the loop a stop check between jobs.
- Nothing proves the loop is alive after boot except its log lines (`job_finished`,
  `cron_drain_completed`).
- Not taken from `ratel-cloud`: the import lane (imports are a Cloud module), the answer-at-once
  cron route (it works around a scheduler's retries, which the `api` role already avoids), and
  the daily top-queries report.
