# 10. A worker stores the telemetry that a gateway put on Kafka

## Status

Proposed. Off by default (`INGEST_QUEUE=direct`).

## Context

A gateway in front of two deployments of Ratel (a Go program, outside this repository) accepts
telemetry, writes it to Kafka, and answers. While an organization moves between the deployments, its
topic is handed from one reader to the other with its offsets. So this core needs to read such topics
and store what they hold, as its own routes would have.

[ADR-0009](0009-queued-ingest.md) put a queue inside one deployment: its routes queue a batch in
Postgres and its own workers persist it, fair across projects. That queue has one writer and one reader,
which are the same deployment, and a claim per project. It cannot hold a topic that another program
wrote, or give one back.

## Decision

**Two queues, for two writers, with one store.**

| | ADR-0009 | This record |
|---|---|---|
| Written by | this deployment's routes | a gateway |
| Holds | `ingest_batches` rows | envelopes on Kafka, a topic per moving organization |
| Switch | `EXPERIMENTAL_INGEST_QUEUE` | `INGEST_QUEUE=kafka` |
| Read by | the ingest lane (`all`, `worker`, `persist`) | a consumer in `worker`, or the single `all` process |
| Order | none: round robin across projects, several tries at once | per project, one at a time |
| Retry | 5 s doubling, 5 tries, then `failed` in the table | 1 s, 5 s, 30 s, 120 s, then a dead-letter topic; an outage does not count |
| Clock of a span without a time | the time of the store | `receivedAt`, the time the gateway took it |
| Stores through | `storeTraceExport`, `storeLogExport`, `storeRuntimeEvents` | the same three functions |

Neither switch reads the other, and both can be on. This core never writes to Kafka: its routes do not
know of it.

**The shared store takes three optional facts** (`RedeliveredContext`): `receivedAt`, `redelivers` (every
failed write fails the store, because the message comes again) and the raw capture's id. Without them it
does what it did.

**A held organization's telemetry is still stored**, by this consumer and by the ingest lane. The hold
stops the jobs that would act on it.

**The gateway obeys the accept rules below.** They were written for one accept in two places; this core's
routes now follow ADR-0009 instead, so the table is what a gateway does before it publishes, and what
process does after.

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
- This core's routes answer as ADR-0009 says, which differs: with its queue on, `{"queued": 1}` for OTLP and
  `{"accepted": 0, "duplicates": 0, "rejected": [], "queued": n}` for events.

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
run gives the same rows (`events.occurred_at` takes it where a request leaves null). The
`received_at` columns stay the time of the store: the fold, the turn builder and the trace
summary sweep read forward by them, and a row with an older value would be skipped.

**A Kafka record** has the project id as its key and the frame as its value, and needs no
header. Brokers and topics must allow 4,100,000-byte messages.

### Queue port

`publish(envelope)` and `consume(handler)`, in `lib/contracts`. The port has no offset,
partition or topic. Tools that need them stay outside it. The Kafka driver and the in-memory one of the
tests pass one conformance suite.

- **Publish** resolves after the message is durable: a Kafka write
  confirmed by all in-sync replicas (at least two). It rejects otherwise.
- **Order** is kept per project: one message of a project is processed at a time, in the order
  the queue confirmed them. There is no order between projects, and none between two requests
  that a client sends at the same time.
- **Delivery is at least once.** Process can see a message again after a crash or
  a rebalance. Every write must give the same rows the second time: ids are deterministic and
  a conflict keeps the stored row. An exception is listed below.
- **A handler ends a delivery** in one of four ways:

| Result | When | The driver |
|---|---|---|
| ack | stored, or nothing to store | commits past it |
| retry | a failure of this message that can pass; also an uncaught error | waits, delivers it again: 5 deliveries, with waits of 1 s, 5 s, 30 s and 120 s, then dead-letters it |
| retry, outage | the store cannot be reached or refuses all work | waits up to 30 s and delivers it again, without limit and without counting. An outage dead-letters nothing |
| dead-letter | it can never pass: a frame, version, body or count that decode refuses, or a project that does not exist | moves it at once |

- **A retry holds its partition**, so the order stays.
- **The count of deliveries** is in memory, so it cannot bound a message that kills the process; the lag
  alert finds it.
- **A dead letter** keeps the original frame, with the reason, the delivery count, and the
  times of the first and the last failure. The reason holds no telemetry content. Nothing
  retries it by itself. Publishing the frame again is safe, but loses its place in the order.
  It is kept as long as its topic keeps it.
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
| `last_used_at`, product events, ingest log lines | A crash can repeat a log line or lose a product event. | Best effort in a request too. |
| Values read at process time: prices, stored logs, SDK invokes near a tool span | A message that is processed late reads the current ones. A stored row keeps its first values. | The same as a late request. |
| A client's own retry | Is a new envelope, so raw capture keeps both bodies. Every other table drops the duplicates. | As in a request. |

### `INGEST_QUEUE`

`direct` (default): nothing is read. `kafka`: the process whose `APP_ROLE` is `worker` or `all` reads an
explicit list of topics (configured, and the edition's, read again while it runs). The driver loads only
with this value. With `{topic}` in the group and dead-letter names, each topic has a group of its own, so
it can be handed over with its offsets.

## Consequences

- A deployment can take over a topic where another reader stopped, and give it back.
- Two queues exist. They share the store, not the retry, the order or the clock; joining them is open.
- A sender behind a gateway learns less: bad payloads and refused traces show in the product and in the
  dead letters, not in the answer.
- Two implementations share one frame. The sample files are the contract, and a change to one
  is a change to the other. They still name ADR-0009, where the frame was first written down: their bytes
  do not change for a reference.
- A message that fails slowly holds its partition for up to 156 s before it is a dead letter.
