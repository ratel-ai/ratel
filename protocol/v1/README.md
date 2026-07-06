# Ratel catalog-source contract — v1

The v1 surface is deliberately small: **catalog pull-sync + authentication.** A catalog
source (the managed cloud today) is the authoritative *source* of a project's published
catalog; a client pulls it and runs retrieval (`search_capabilities` / `invoke_tool` /
`get_skill_content`) **locally** over that replica. There is no remote search/invoke on the
wire — see [ADR-0019](../../docs/adr/0019-catalog-source-interface.md) (the embedded-replica
model). Auth and scope are [ADR-0020](../../docs/adr/0020-catalog-source-auth-and-scope.md);
sync and storage semantics are
[ADR-0021](../../docs/adr/0021-catalog-sync-and-storage.md).

Transport is HTTP/1.1+ with JSON bodies. All paths are under `/v1`. The in-process library
speaks none of this — it reads local disk; the contract is for **networked** sources.

## Authentication

Every `/v1` request to a networked source carries `Authorization: Bearer <key>`. The source
takes `sha256(key)` (hex) and looks it up against active keys (`key_hash = $ AND revoked_at IS
NULL`). Keys are stored **hash-only** — plaintext is shown once at creation and never
persisted (ADR-0020).

- missing or malformed header → `401`
- unknown or revoked key → `401`
- key store unreachable → `503`

A networked source MUST be served over TLS; a bearer key is a replayable static secret. Every
`/v1` request to a networked source carries a key — v1 has no loopback exception (see
non-goals).

## Catalog pull-sync

### `GET /v1/catalog`

Returns the project's published catalog. Conditional-GET with an `ETag`; the client caches
the last body and revalidates.

**Query parameters**

- `scope` *(optional)* — an opaque subject id (the SDK's end-user identifier). Selects the
  subject-scoped catalog layer on top of the global layer. Absent ⇒ the global layer only,
  which is byte-compatible with a source that has no notion of subjects.

**Request headers**

- `If-None-Match: <etag>` *(optional)* — the client's cached ETag.

**Responses**

- `200 OK` — body below, plus `ETag: "<hash>"` and `Cache-Control: no-cache`.
- `304 Not Modified` — the client's `If-None-Match` matches the current ETag **for the same
  scope**; no body. An `If-None-Match` is only valid within the scope it was issued for.
- `401` / `503` — per Authentication.

**200 body**

```
{
  "catalogVersion": "<etag-string>",
  "skills": [ CatalogSkillWire, ... ]
}
```

`CatalogSkillWire` mirrors the kernel `Skill` struct field-for-field, so a client hydrates
its `SkillCatalog` with no remapping:

```
{
  "id":          string,
  "name":        string,               // kebab, unique within the project's set
  "description": string,
  "tags":        string[],
  "tools":       string[],             // skill's referenced tool ids
  "metadata":    { [key: string]: string[] },
  "body":        string                // SKILL.md payload
}
```

v1 serves **skills only** (mirroring today's catalog). Tool definitions in the pull, and any
authoring/write path, are deferred (PSKS-8) and land as additive `/v1` extensions.

### Tool resolution (client-owned registry)

A synced skill's `tools` are tool **ids**, not definitions. The **tool registry is
client-owned** — tools are registered in-process by the SDK (e.g. from the client's own
upstream MCP servers). A referenced id resolves against that local registry; an id with no
local definition behaves as unknown-tool at invoke time, though the skill stays discoverable by
search. A source-published skill is therefore a coupling contract: it should reference only
tools the consuming client registers locally. Syncing tool definitions to close this gap is a
deferred extension (PSKS-8).

### ETag algorithm (frozen at v1)

The ETag is a content hash over the **resolved published set for the request's scope**, each
skill projected to exactly `{id, name, description, tags, tools, metadata, body}` and the set
sorted by `id`. Timestamps, status, and version are **excluded**, so a byte-identical
republish keeps the ETag stable. The global (`scope` absent) case is served from a stored
per-project catalog-version value without materialising the set.

`If-None-Match` comparison tolerates weak (`W/`) prefixes, surrounding quotes, comma-lists,
and `*`.

Because the ETag is part of the compatibility surface, **the content projection above is
frozen at v1**: changing which fields are hashed invalidates every client's cache and is a
breaking (v2) change.

## Operational endpoints

- `GET /healthz` — unauthenticated liveness probe for a networked source. Not under `/v1`,
  not versioned, returns `200` with no meaningful body.

## Error model

Every non-2xx `/v1` response carries a uniform body:

```
{ "error": { "code": string, "message": string, "details"?: object } }
```

v1 codes: `unauthorized` (401), `not_found` (404), `invalid_request` (400),
`unavailable` (503). (`409` conflict codes arrive with the authoring surface, PSKS-8.)

## Conformance

A language-agnostic conformance-vector set is part of this contract: fixture catalogs → their
expected ETag, scope-overlay cases, and `If-None-Match` / 304 semantics. Every source (the
managed cloud, any loader, a future server) MUST pass them, so the contract — not the single
closed implementation — stays normative. The ETag content projection and the secrets-never-sync
rule (ADR-0021) each get a vector.

## Versioning

- Major version is the URL prefix `/v1`. Additive changes (new optional fields, new
  endpoints) stay within `/v1`; clients MUST ignore unknown fields.
- The frozen v1 surface: the `Authorization: Bearer` scheme and 401/503 contract, the
  `GET /v1/catalog` shape, the `scope` selector semantics, `CatalogSkillWire`, and the ETag
  content projection. A break in any of these is a `/v2`.

## Explicit non-goals for v1

- **No remote search / invoke / get_skill over the wire.** The client runs the kernel's BM25
  and the gateway tools locally over the pulled replica (ADR-0019). A source-side gateway is a
  possible later addition (PSKS-8), not a v1 shape.
- **No authoring / CRUD / publish / archive.** Deferred to PSKS-8; a local file source has no
  version semantics, so mutation verbs are not part of the v1 read contract.
- **No telemetry ingest.** Remote telemetry is stock OTLP `http/protobuf` + Bearer into a
  separate receiver ([ADR-0015](../../docs/adr/0015-telemetry-otel-conventions.md)), never
  this contract.
- **Secrets never appear on the wire.** OAuth tokens and API keys stay in the local secret
  stores; no field of any v1 shape can carry one (ADR-0021).
- **No loopback auth exception in v1.** A future local-daemon source that skips auth for
  same-machine clients is deferred with the server (ADR-0019).
- **No suggestion / analytics / ranking surface.** The cloud's differentiated features are a
  private API outside this contract (ADR-0019); a source is not expected to implement them. The
  usage-ranking read model may later be brought on-contract (RCSR-5).
