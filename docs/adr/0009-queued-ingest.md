# 9. Ingest accepts a batch fast and a fair queue persists it

## Status

Accepted, behind `EXPERIMENTAL_INGEST_QUEUE=1` (off by default).

## Context

`POST /api/v1/traces`, `/logs` and `/events` decoded, normalized and wrote every derived table
inside the request. A batch of about 700 spans took about 3 s, on the processes that also serve the
console. One project backfilling thousands of such batches slowed every tenant and the console
(RTL-312). A self-hoster runs one application and one Postgres with no separate worker, and that
must keep working with no extra setup.

## Decision

**The request only accepts.** With the flag on, a route authenticates, checks the key's scope, the
Content-Type, the declared and streamed body size, the decompressed size and the monthly plan cap,
stores the body as it arrived in `ingest_batches` (with its `Content-Encoding`) and answers 202. It
does not decode, with one exception: while `customMonitoring` is on for the organization, a trace
export that carries an IP address or coordinates is located and rewritten without them first, because
a stored body must not hold them (`ingest/geo/redact.ts`). One that cannot be rewritten stays inline.
Auth (401/403), size (413), encoding (415, 400 for a bad gzip) and plan-cap (429)
answers are unchanged. What needs a decode moves to the worker and no longer reaches the caller: a
malformed payload, the span or record count bound, and the edition's span bounds. An ingest-only
(publishable) key stays inline: its budget counts decoded items in a process-local limiter.

**A worker writes through the inline path.** `persistIngestBatch` inflates, decodes and calls the
same functions the inline routes call (`storeTraceExport` → `persistDecodedSpans`,
`storeLogExport`, `storeRuntimeEvents`). Every row id is deterministic, so a batch that runs twice
adds no row and no usage.

**The claim is fair across projects.** `claimNextIngestBatch` takes the oldest queued batch whose
backoff has passed (`FOR UPDATE SKIP LOCKED`), leaving out a project that already has
`INGEST_PERSIST_PER_PROJECT` (1) batches running.
A backlog holds at most that many workers; every other project's batches are claimed around it.
A drainer takes turns: a project it has not served goes first, then the one it served longest ago.

**At least once, then failed.** A write that fails goes back to the queue after a backoff (5 s,
doubling, at most 5 min) until `INGEST_BATCH_MAX_ATTEMPTS` (5). A batch that cannot decode fails at
once. A failed batch keeps its bytes and its error. A batch `running` for 5 minutes is put back by
the reaper (or failed past its tries).

**Where it runs, by `APP_ROLE`** ([ADR-0005](0005-background-worker.md)):

| `APP_ROLE` | Ingest batches | Migrates |
|---|---|---|
| `all` | persisted after the response (at most `INGEST_PERSIST_CONCURRENCY` drains per process) and by the tick's safety-net drain | yes |
| `api` | only queued | yes |
| `ingest` (new) | only queued; for a deployment that routes the ingest paths to their own service | never |
| `worker` | persisted by its ingest lane (`INGEST_PERSIST_CONCURRENCY` loops) | never |
| `persist` (new) | persisted by the ingest lane, and nothing else runs | never |

**Operators see the queue.** Each tick logs `ingest_queue_depth` per project (queued, running,
oldest queued age, failed in the last hour) and puts the totals on `cron_drain_completed`. Each
batch logs `ingest_batch_persisted` (with its queue wait), `ingest_batch_retry` or
`ingest_batch_failed`.

**Retention is the queue's own.** A done batch drops its body at once; its row goes after an hour,
a failed one after a week, whatever `DATA_RETENTION_ENABLED` says. Migration `0046` only adds the
table.

## Consequences

- A caller with the flag on learns of a bad payload only from the logs, and gets `{ queued: 1 }`
  (OTLP) or `{ accepted: 0, duplicates: 0, rejected: [], queued: n }` (events) instead of counts.
- Data trails ingest by the queue's wait: seconds normally; for a backfilling project, its own
  backlog.
- Measured (`web/scripts/load-test-ingest-queue.mts`): while one project sent 3,000 700-span
  batches, a second project's ingest and console latencies stayed within 2x of their baseline when
  an accept process and a persist process are split (as Cloud runs them); inline they went 19x and
  12x. In one all-in-one process the p50s and the console stay within 2x, and the second project's
  ingest p95 sits at about 2x (about 30 ms), as persist work shares the event loop with accepts.
  With `INGEST_PERSIST_CONCURRENCY=1` a single drainer splits its capacity by batch, and a busy
  neighbour halves everyone else's share.
- The per-project cap is soft: two claims at the same instant can each pass it.
- Turning the flag off stops queueing at once; the lanes and the tick keep draining what is left.
- An ingest-only key's item budget (and a per-project item budget charged after a decode) only
  applies on the inline path.
