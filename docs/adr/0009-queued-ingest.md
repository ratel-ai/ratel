# 9. Ingest is accepted at the door and processed from a queue

## Status

Accepted

## Context

`POST /v1/traces`, `POST /v1/logs` and `POST /api/v1/events` authenticate, decode, store and
answer inside one request. A slow database slows every sender, and a failed insert becomes a
500 that the sender must retry. Telemetry cannot be held, replayed, or moved to another
consumer.

A queue between the answer and the store fixes this, but the answers of today need decoded or
stored data: counts from the insert, a 429 from the trace meter, the item count of a shared
key, and a 400 for a body that does not decode. A writer outside this repository (the managed
service's gateway, in Go) must also put the same message on the queue, without a copy of the
decoders.

## Decision

**Ingest has two steps.** *Accept* runs in the request. It decides from the headers, the key
and the size, publishes one envelope, and answers. *Process* runs in a consumer. It decodes,
stores and starts the follow-up jobs. Accept never maps or stores telemetry. Process never
answers a client, and never stops for a rate limit or a quota.

**Every writer of the queue obeys the same accept rules.** A client gets the same answer from
the core's routes and from any other writer.

### What runs where

| Check or effect | Accept | Process | Notes |
|---|---|---|---|
| Content type | 415 | | Traces, logs: protobuf or JSON. Events: JSON only. |
| Declared and streamed size, 4,000,000 bytes | 413 | | The body as received, before decompression. |
| Key, scope | 401, 403, 503 without a database | | Traces and logs answer 415 and 413 (declared size) after a missing key and before the lookup, events before both, as today. |
| Project's organization | never refuses | current row | `organizationId` is read with the key, from the project row (`projects.organization_id`, not null). No organization row: no quota check and no metering, as today. |
| Request rate limit | 429, `Retry-After` | | Shared keys: per key and per source. Secret keys on events: 120 a minute. |
| Monthly event quota (`checkEventQuota`), traces | 429 | | From an answer cached for at most 60 s per organization, so a 429 can start or stop up to 60 s late. Not for a metered organization. Process never asks again. |
| `isMetered`, traces | cached, 60 s | yes | Accept only asks whether the quota applies. Process asks again before it meters. |
| `Content-Encoding`, traces and logs | 415 | | Absent, `identity`, `gzip`, `x-gzip` or `deflate`. On events the header is ignored, as today: the body is JSON as sent. |
| Decompression, 16,000,000 bytes | shared keys only | yes | See *Shared keys*. |
| Events shape: JSON with an `events` array of at most 5,000 | 400, 413 | yes | The answer needs the count. |
| Item budget (`chargeItems`) | shared keys only | | See *Shared keys*. |
| Publish | 503 on failure | | 202 only after the driver confirms that the message is durable. |
| OTLP decode, 5,000 spans or records | | yes | Failure is permanent: dead letter. |
| Per-event validation (`parseTraceEvents`) | | yes | Rejects go to `trace_event_rejects`. |
| Trace meter (`meterTraceBatch`) | | yes | A refused or dropped trace is final: its spans are not stored, the message is acknowledged, and a log line counts them. No 429. |
| Store, and `appendOnlyIngest` from the envelope | | yes | The flag as it was at accept. |
| `incrementEventUsage` | | yes | By rows stored, so a redelivery adds nothing. |
| `rejoinLateGenAiLogs`, `rejoinStoredModelCalls` | | yes | Unchanged: both sides store first and read after, so they do not depend on order. |
| Fold, clustering and turn-build jobs | | yes | Enqueued only. The worker drains them. A delivery without a new row enqueues them too, because the one that stored the rows can have ended before. |
| Raw capture (`otlp_raw_exports`) | | yes | After a complete store. The row id is the envelope id, so a redelivery adds no row. |
| `last_used_at` | | yes | After the store, for all three signals: the later of the stored value and `receivedAt`. Best effort. A refused request no longer counts as a use. |
| First-trace event, ingest counts, `runtime_events_ingested` | | yes | From the stored counts. Accept logs the request and its refusals. |

**Shared keys.** A key with `sharedKeyLimits` ships inside apps, so its budget must hold
before the message is durable. For these keys only, accept decompresses the body under the
16,000,000-byte limit and counts spans, records or events. The count is a walk of the outer
structure; nothing is mapped. A body that cannot be counted answers 400, and an over-large one
or one with too many items 413, as today; only the detail after `Malformed OTLP payload:` can
differ. The walk is not the decoder: a body that it can count and the decoder refuses answers
202 and becomes a dead letter. The body of a secret key's OTLP export is not read beyond its
bytes.

### Answers

Each refusal in the Accept column keeps today's status and body, except *Publish*, whose 503
is the one new refusal. The refusals that need decoded or stored data are gone: the meter's 429
and the storage 500 for every key, and the 400 and 413 of decompression and OTLP decode for
secret keys. A success is 202 and no longer depends on storage:

| Signal | Request type | Body | Headers |
|---|---|---|---|
| traces, logs | protobuf | empty (a full-success `Export…ServiceResponse`) | `content-type: application/x-protobuf` |
| traces, logs | JSON | `{}` | `content-type: application/json` |
| events | JSON | `{"accepted": <events in the batch>, "duplicates": 0, "rejected": []}` | `content-type: application/json` |

- No `x-ratel-*` header is sent. The counts of OTLP JSON bodies (`accepted`, `calls`, `spans`,
  `refused`, `records`, `dropped`) are gone.
- `duplicates` is always 0, and `rejected` is always empty. This is deliberate, and differs from
  the plan that this record came from, which returned the rejects. To fill the list, every
  writer of the queue needs the per-event validation, and that stays in one place, in
  TypeScript. Process finds a reject and stores it in `trace_event_rejects`, and it shows in
  Settings > Developer. The SDK reads a missing reject as accepted.
- A failed publish is 503 (the new refusal) with `{"error": "Ingestion is not available. Try again."}` and
  `Retry-After: 5`. A publish that does not confirm in 10 s is a failure, and can still have
  been written: the retry is then a duplicate, which storage drops.
- In `direct` mode, every answer stays as it is today.

A caller inside the repository that needs counts calls the process function, which returns
them. `console/seed/site-copilot-seed.ts` sums the response counts today; it moves to the
process function when direct mode is removed.

### Envelope

One message is one accepted request. `web/src/lib/ingest/queue/` holds the type, the codec and
the sample files that every implementation must read and write byte for byte.

| Field | Type | Meaning |
|---|---|---|
| `version` | integer, 1 | The envelope version. |
| `id` | UUID | One per accepted request. A client retry gets a new one. |
| `projectId` | UUID | The project of the key. The unit of order. |
| `organizationId` | UUID | The project's organization at accept, for routing and archives. Process reads the current one. |
| `keyId` | UUID | The API key's row id. Never the key or its hash. |
| `keyPolicy.appendOnlyIngest` | boolean | `ApiKeyPolicy.appendOnlyIngest` at accept. |
| `keyPolicy.sharedKeyLimits` | boolean | `ApiKeyPolicy.sharedKeyLimits` at accept. |
| `signal` | `traces`, `logs`, `events` | Which process function runs. |
| `contentType` | `application/x-protobuf`, `application/json` | How to decode, resolved by accept. `events` is always JSON. |
| `contentEncoding` | `identity`, `gzip`, `deflate` | How the body is compressed, resolved by accept (`x-gzip` is `gzip`). `events` is always `identity`. |
| `receivedAt` | integer, 0 to 253402300799999 | Unix milliseconds when accept took the request. |
| `body` | bytes, 0 to 4,000,000 | The request body as received, not decoded. |

UUIDs are lowercase with hyphens. The frame is binary, so a body is never re-encoded:

| Bytes | Content |
|---|---|
| 4 | `RTLE` |
| 1 | `version`, unsigned |
| 4 | header length, unsigned, big endian, at most 4,096 |
| header length | the header: UTF-8 JSON of every field but `version` and `body`, in the order of the table, no whitespace, `keyPolicy` as an object |
| the rest | `body` |

- An envelope has exactly one encoding. A decoder refuses a header that is not the bytes it
  would write: another order, whitespace, an unknown or missing field.
- A decoder reads the magic and the version first, and refuses a newer version before the
  rest. Any change to the header or the frame is a new version.
- Consumers learn a version before any writer sends it.

**`receivedAt` is the clock of process.** Where ingest falls back to "now" for an event's time
or tests a timestamp for being in the future, process uses `receivedAt`, so a late or repeated
run gives the same rows (`events.occurred_at` takes it where direct mode leaves null). The
`received_at` columns stay the time of the store: the fold, the turn builder and the trace
summary sweep read forward by them, and a row with an older value would be skipped.

**A Kafka record** has the project id as its key and the frame as its value, and needs no
header. Brokers and topics must allow 4,100,000-byte messages.

### Queue port

`publish(envelope)` and `consume(handler)`, in `lib/contracts`. The port has no offset,
partition or topic. Tools that need them stay outside it. Every driver passes one conformance
suite.

- **Publish** resolves after the message is durable: a committed row, or a Kafka write
  confirmed by all in-sync replicas (at least two). It rejects otherwise.
- **Order** is kept per project: one message of a project is processed at a time, in the order
  the queue confirmed them. There is no order between projects, and none between two requests
  that a client sends at the same time.
- **Delivery is at least once.** Process can see a message again after a crash, a lost lease or
  a rebalance. Every write must give the same rows the second time: ids are deterministic and
  a conflict keeps the stored row. An exception is listed below.
- **A handler ends a delivery** in one of four ways:

| Result | When | The driver |
|---|---|---|
| ack | stored, or nothing to store | removes the message or commits past it |
| retry | a failure of this message that can pass; also an uncaught error | waits, delivers it again: 5 deliveries, with waits of 1 s, 5 s, 30 s and 120 s, then dead-letters it |
| retry, outage | the store cannot be reached or refuses all work | waits up to 30 s and delivers it again, without limit and without counting. An outage dead-letters nothing |
| dead-letter | it can never pass: a frame, version, body or count that decode refuses, or a project that does not exist | moves it at once |

- **A retry holds its project.** Later messages of the project wait, so the order stays. A
  Kafka driver may hold the whole partition.
- **The count of deliveries** is durable in the Postgres driver. The Kafka driver keeps it in
  memory, so it cannot bound a message that kills the process; the lag alert finds it.
- **A dead letter** keeps the original frame, with the reason, the delivery count, and the
  times of the first and the last failure. The reason holds no telemetry content. Nothing
  retries it by itself. Publishing the frame again is safe, but loses its place in the order.
  It is kept 14 days. A project's queued and dead messages are deleted with the project.
- **Stop.** `consume` returns a handle. Its `stop()` takes no new message, lets the handler in
  hand finish, makes its ack durable, releases the driver's claims and resolves. A message that
  waits for a retry is given back unacknowledged. The worker calls it on SIGTERM as part of the
  stop in [ADR-0005](0005-background-worker.md); a second signal exits at once, and the message
  is delivered again.

**What a second delivery can change.** `queue/duplicate-safety.integration.test.ts` kills the
process at every statement of each signal, delivers the message again and compares every table
with one clean run. `events` and `event_metrics` are one transaction, and an event that an older
build left without its metrics gets them when it is sent again (the check command is in
`web/src/lib/ingest/README.md`). `tool_usage_counters` move with new rows in the transaction that
stores them. `otlp_raw_exports` is keyed on the envelope id. The match-quality label occurrences
are not written by ingest. These differences are accepted:

| What | Can change | Why it stays |
|---|---|---|
| The monthly counter (`incrementEventUsage`) | A crash between the store and the count leaves one message's events uncounted. Never counted twice. | The counter is the edition's, outside the transaction, and the error favours the customer. |
| The span bound of a trace (`meterTraceBatch`) | A crash between the meter and the store counts the message's spans twice against the bound. A trace's outcome does not change. | The meter is the edition's and has no message id. At most one message per crash. |
| `last_used_at`, product events, ingest log lines | A crash can repeat a log line or lose a product event. | Best effort in direct mode too. |
| Values read at process time: prices, stored logs, SDK invokes near a tool span | A message that is processed late reads the current ones. A stored row keeps its first values. | The same as a late request in direct mode. |
| A client's own retry | Is a new envelope, so raw capture keeps both bodies. Every other table drops the duplicates. | As in direct mode. |

### `INGEST_QUEUE`

| Value | Accept publishes to | Consumed by |
|---|---|---|
| `direct` (default) | nothing: the request decodes, stores and answers as before | |
| `postgres` | a spool table, apart from the jobs table | the process whose `APP_ROLE` is `worker` or `all` |
| `kafka` | the configured topic | the same, from an explicit list of topics (configured, and the edition's, read again while it runs). The driver loads only with this value. Without a topic to publish to, the deployment only consumes and its own routes stay direct |

`direct` stays the default until the migration from Ratel Cloud closes. Then `direct` is
removed and `postgres` becomes the default. A process with `APP_ROLE=api` publishes and never
consumes.

### For self-hosted deployments

Nothing changes until `INGEST_QUEUE` is set. With a queue:

- A 202 means "kept", not "stored". Data shows seconds later, and only while a worker (or an
  `all` process) runs.
- A malformed OTLP body, or one with more than 5,000 spans or records, from a secret key
  answers 202 and becomes a dead letter. It answered 400 or 413 before.
- The answers lose their counts, and events lose `duplicates` and `rejected`.
- A quota answer can be up to 60 s late. This edition has no quota.
- `postgres` takes spikes and slow processing. It does not take a Postgres outage: accept needs
  Postgres for the key and for the spool, and answers 503.
- The spool holds request bodies as received, with any content in them, until they are
  processed, and dead letters for 14 days. Plan disk for a worker outage.

## Consequences

- A slow or failing store no longer reaches the sender. The sender retries only when the queue
  itself refuses.
- A sender learns less: bad payloads and refused traces show in the product and in the dead
  letters, not in the answer.
- The wire contracts of [ADR-0007](0007-sdk-wire-contracts.md) do not change: the SDK reads
  the status, and reads the events counts as given.
- Two implementations share one frame. The sample files are the contract, and a change to one
  is a change to the other.
- A message that fails slowly holds its project for up to 156 s before it is a dead letter.
