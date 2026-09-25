# 25. Intent graph storage plugins (local file, S3)

Date: 2026-09-21

## Status

Accepted

Builds on the persistence contract [ADR-0014](0014-adaptive-usage-ranking.md)
deliberately left open.

## Context

[ADR-0014](0014-adaptive-usage-ranking.md) made `IntentGraph` persistence
caller-owned on purpose: "Ratel runs with no infra and must not pick a backend
(file, SQLite, the app's own DB, S3)." It gave the caller `toJson`/`fromJson`
and a monotonic `rev` counter for **save-when-changed** and **stale-base
detection**, but nothing in either SDK actually used them — there was no
local-file backend, let alone an S3 one. Every caller who wanted the graph on
disk had to write that loop themselves.

Adding S3 support was requested with two hard constraints: it must not change
adaptive-ranking behavior (core stays untouched), and it must not add an
install step — no `boto3`, no `@aws-sdk/client-s3`. Development had to be
possible offline, so the whole suite runs without credentials or network; the
live validation against real AWS S3 and a self-hosted MinIO was completed
before merge, not deferred.

## Decision

Add an SDK-layer-only storage plugin pair to both SDKs, under `experimental*`
naming (CONTRIBUTING.md's additive-surface convention). `ratel-ai-core`
(`usage.rs`, `usage_learner.rs`) is not touched — everything here is a thin
adapter over the existing `toJson`/`fromJson`/`rev` contract.

**Interface** (per SDK): `{ load(): Promise<IntentGraph | null>; save(graph): Promise<void> }`
in TS, an `async` `Protocol` with the same two methods in Python. Object-owns-
lifecycle, not a free function plus a strategy argument — matches the existing
`ToolCatalog`-style idiom.

**Two implementations:**

- `ExperimentalLocalFileIntentGraphStorage` — the previously-missing default.
  Written to a temp file and renamed into place, so a process that dies
  mid-write leaves the previous graph intact rather than a truncated one. The
  rename is atomic; the bytes are not fsynced, so a machine-level crash can
  still lose the most recent save. The temp file is created `0600` and the
  rename carries that mode onto the target: the graph holds raw user query
  text (see `IntentGraph.toJson`).
- `ExperimentalS3IntentGraphStorage` — new. Talks to the S3 REST API directly:
  a minimal, dependency-free AWS SigV4 signer (`sigv4.ts` / `ratel_ai/_sigv4.py`,
  stdlib-only: `node:crypto`/native `fetch`, `hashlib`/`hmac`/`urllib`) plus
  `GetObject`/`PutObject`. No `boto3`/`@aws-sdk/client-s3` dependency — the
  base SDK install is unaffected for the majority of callers who won't use S3.

**Concurrency.** Both implementations use `rev` exactly as ADR-0014 specified:

- *Save-when-changed*: the storage object remembers the last-saved `rev`
  in-process; `save()` is a no-op if `graph.rev` hasn't moved.
- *Stale-base detection*, via a real conditional-write primitive per backend:
  - **S3**: `PUT` with `If-Match: <etag>` (S3 conditional writes, GA since
    August 2024 — no bucket versioning required); first write uses
    `If-None-Match: *`. A `412 Precondition Failed` raises
    `StaleIntentGraphError` — no retry, no merge, matching ADR-0014's
    single-writer model ("`rev` makes a collision detectable, not merged").
  - **Local file**: re-read the on-disk `rev` immediately before the atomic
    write; a mismatch raises `StaleIntentGraphError`. Best-effort — there is
    a narrow TOCTOU window inherent to plain files, not solved with OS locks
    in this version.

A storage object that never `load()`ed also cannot blindly overwrite an
existing object/file: with no known base `rev`/etag, the first `save()` uses
the same "object must not already exist" conditional (`If-None-Match: *`
on S3; an equivalent disk check locally) and raises `StaleIntentGraphError`
if it does.

**Credentials.** Explicit `{accessKeyId, secretAccessKey, sessionToken?}` /
`ExperimentalS3IntentGraphStorageCredentials`, falling back to
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` env vars.
`~/.aws/credentials` file parsing and instance-role resolution are explicitly
deferred — not built in this version.

**Testability.** Both S3 implementations take an injectable transport
(`S3Transport` / a `send()`-shaped protocol), so the full test suite —
including the conditional-write race and the SigV4 signer itself — runs
without AWS credentials or network access. Verified live against real AWS S3
and, separately, a self-hosted MinIO instance (see S3-compatible endpoints
below).

**S3-compatible endpoints (MinIO, etc.).** Driven by a real customer
requirement (a MinIO/managed-S3 deployment, not AWS), `endpoint` and
`forcePathStyle`/`force_path_style` options were added to
`ExperimentalS3IntentGraphStorage`. `endpoint` (e.g.
`"http://localhost:9000"`) overrides the AWS virtual-hosted host entirely;
omit it for AWS S3, unchanged. `forcePathStyle` defaults to `true` once
`endpoint` is set — most self-hosted S3-compatible services need path-style
addressing (`https://endpoint/bucket/key`) since virtual-hosted style
(`https://bucket.endpoint/key`) needs a wildcard DNS/TLS setup self-hosted
deployments rarely have; pass `false` for a custom endpoint that does support
virtual-hosted style (e.g. Cloudflare R2). The scheme/host/path resolution
is a pure function (`resolveS3Endpoint` / `resolve_s3_endpoint`) independent
of the transport, so it's unit-tested directly rather than only through a
live server — the same pattern that made `awsUriEncode`'s AWS UriEncode
spec-compliance (`!*'()` percent-encoding) independently testable too. No
change to the SigV4 signing algorithm
itself: MinIO (and most S3-compatible services) implement the same SigV4
scheme AWS does. TLS trust for self-signed certificates and region-string
validation are both out of scope — pass whatever the host environment
already trusts / the service is configured with.

## Consequences

Non-breaking and additive: `IntentGraph`, `toJson`/`fromJson`/`rev` are
unchanged, and `ratel-ai-core` has zero diff. Callers who want the intent
graph on disk (a case that previously required writing the persistence loop
from scratch) now have a ready local-file default; callers who want S3 get it
with no new dependency to install. The cost is duplicated maintenance across
two SDKs (TS and Python each carry their own SigV4 signer and storage
classes) rather than one core implementation — accepted because ADR-0014
already ruled out putting a backend choice in core, and a hand-rolled SigV4
client is small and stable relative to the alternative of a heavy, everyone-
pays SDK dependency.

**What these backends persist.** Until now the warning on `IntentGraph.toJson`
sat on an API most callers never reached, because there was no backend. These
are the first two, so it belongs here: a serialized graph contains the **raw
text of past user queries** (the cluster `members`). Treat a stored graph like
a query or telemetry log. Locally that means the `0600` the file backend now
writes, and keeping it out of version control and out of images. In S3 it
means the bucket is a place that data is allowed to live: private access
block, encryption at rest, and a lifecycle that matches whatever retention the
query text is subject to. Neither backend encrypts the payload itself; the
graph is stored as plain JSON.

Follow-ups, explicitly out of scope here: `~/.aws/credentials` / instance-role
credential resolution; TLS trust configuration for self-signed certificates
on a self-hosted endpoint.
