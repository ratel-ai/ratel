# 19. Catalog source is a pluggable loader interface, not a shipped server

Date: 2026-07-05

## Status

Proposed (partially supersedes [ADR-0014](0014-product-split-kernel-server-local-cloud.md))

## Context

[ADR-0014](0014-product-split-kernel-server-local-cloud.md) named a `server` product — a
shipped `ratel-ai-server` crate / `ratel-server` binary / `@ratel-ai/server` distribution
that wraps the kernel and speaks a wire protocol — as the rung between the in-process library
and the managed cloud. It marked the server "decided, not yet shipped" and scheduled it for
Phase 4.

Two things became clear while specifying Phase 4:

1. Under the pull-sync / embedded-replica model we adopted (the client pulls the published
   catalog and runs BM25 locally — [ADR-0021](0021-catalog-sync-and-storage.md)), the
   "server" in v1 is only a **source of the catalog**. It stores skill definitions and answers
   a conditional GET. It does not run retrieval.
2. The managed cloud already is exactly that source — a published-catalog conditional-GET with
   ETag/304 (today routed at `/api/v1/catalog`, which `protocol/v1` normalizes to
   `/v1/catalog`). A separate OSS server binary would be a second implementation of the same
   thin contract, built ahead of any demonstrated demand for self-hosting.

What earns a fork is the engine (already OSS) and the self-improvement intelligence — not a
CRUD service around a catalog table. Building and maintaining a server binary now spends
effort on the speculative tier and buys little.

## Decision

**We do not build a standalone server now. The catalog is populated through a pluggable
_source / loader_ interface in the SDK. The managed cloud is the first source, shipped as
`@ratel-ai/cloud` (TS) and `ratel-ai-cloud` (Python). The library remains the single
artifact; a standalone OSS server is deferred until real self-hosted demand — at which point
it is an _implementation of the already-published source contract_, not a new design.**

### The source / loader interface

- The SDK's `ToolCatalog` / `SkillCatalog` gain a **source seam**: a catalog can be filled
  from native in-process registration (the floor), or from a **source loader** that pulls a
  published catalog and hydrates the local registries. Retrieval
  (`search_capabilities` / `invoke_tool` / `get_skill_content`) always runs locally over
  those registries — the embedded-replica model, unchanged.
- `RATEL_URL` names a **remote source** (the managed cloud, or later a self-hosted one).
  Setting it selects the remote source loader (the cloud loader today, a self-hosted loader
  later); unset is the embedded floor. This is ADR-0014's "one API, two transports," with the
  remote transport now realized as a source loader over a source-compatibility contract rather
  than a bespoke client of a server's wire protocol. Application code calling
  `search` / `invoke` / `get_skill` does not change.
- Additional sources — a local file/dir loader, a git loader, a self-hosted endpoint — are
  added as loaders when a use case appears. The interface is the extension point; each loader
  is small.

### What a source serves — and the tool-resolution contract

- A source serves **skill definitions** (v1 is skills-only, mirroring today's catalog —
  [`protocol/v1`](../../protocol/v1/README.md)). Tool *definitions* do not sync in v1; a
  skill's `tools` field is a list of tool **ids** it references, not their schemas.
- **The tool registry is client-owned.** Tools are registered in-process by the SDK (e.g. from
  the client's own upstream MCP servers). A synced skill's referenced tool ids resolve against
  that **local** registry: an id with no local definition behaves as unknown-tool at invoke
  time (the existing `invoke_tool` `{error, isError}` path), and the skill is still
  discoverable by search. So a centrally-published skill is a real coupling contract: it should
  reference only tools the consuming client registers locally. *(Whether to pull tool
  definitions into the pull-sync — closing this gap for fully-remote skills — is deferred to
  PSKS-8; flagged as an open question below.)*

### `@ratel-ai/cloud` / `ratel-ai-cloud` — the first source, and the value tap

- Implements the **catalog-source contract** against the managed cloud: pull the published
  catalog (ETag/304), hydrate the SDK. This half is the published `protocol/` spec, and must
  never diverge from it.
- It is **also** the developer's tap into the cloud-only intelligence — the skill-suggestion
  flow, usage analytics, and (later) the usage-derived ranking signal. **Those surfaces are
  deliberately _outside_ `protocol/v1`** (a private cloud API the package may use). The
  "never a private API" discipline is therefore scoped to the *catalog-pull + auth* contract
  only; the differentiated value is expected to be off-protocol until we choose to open it (the
  usage-ranking read model is the first candidate to bring on-contract — RCSR-5).

### The wire contract is the insurance policy (for the commodity rung)

The catalog-source contract (pull-sync, ETag/304, `CatalogSkillWire`, Bearer auth, `?scope=`)
is specified in [`protocol/`](../../protocol/v1/README.md) as a compatibility surface any
source implements — the cloud today, a self-hosted server tomorrow, a third-party loader.
Keeping `@ratel-ai/cloud`'s catalog half an **implementation of that published spec** is what
makes a future OSS server cheap *to assemble*. Be clear-eyed about what that buys: the contract
covers the **commodity catalog-serving rung only**. A future server that faithfully implements
`protocol/v1` gets catalog serving and nothing of the cloud's differentiated value unless those
surfaces are separately opened. The road back is cheap for the skeleton, not the building. Auth
is [ADR-0020](0020-catalog-source-auth-and-scope.md); sync and storage classes are
[ADR-0021](0021-catalog-sync-and-storage.md).

### What this defers

- The `ratel-ai-server` crate, `ratel-server` binary, `@ratel-ai/server` npm packages, and the
  `server-v*` release unit / distribution channel are **not built**. The names stay reserved —
  held by intent (ADR-0014's "reserved naturally by first RC publish" mechanism does not apply,
  since there is no server RC), revisited when the server is.
- **Shared self-hosting and air-gapped / enterprise are genuinely deferred, not covered.** "A
  self-hoster can write a source loader" is only the *client* half; nobody ships the *server*
  side that answers `GET /v1/catalog` with auth, scope, ETag, and a key store. Air-gapped /
  enterprise ("give us a box") has **no partial coverage** — the loader/cloud model requires
  reaching the managed endpoint. The un-defer trigger is real self-hosted or enterprise demand
  (e.g. a signed air-gapped deal); naming it here so positioning does not assume the loader
  story satisfies it.
- Phase 5 (`ratel-local`) no longer re-points at a server binary; it stays the local
  distribution shell over the library and the source loaders. *(A multi-process, single-machine
  "loopback daemon source" — several editors sharing one catalog+auth cache — is a distinct,
  much cheaper deferred item with a concrete ratel-local consumer, not bundled into "the
  server.")*

### Supersession

Partially supersedes [ADR-0014](0014-product-split-kernel-server-local-cloud.md). When this ADR
is Accepted, 0014's Status gains a "partially superseded by ADR-0019" back-pointer (no edit to
its decision text).

Superseded / amended:

- The **`server` product row** and its "decided, not yet shipped" server: the server is now
  *deferred*, its v1 role (a catalog source) covered by the cloud plus the source-loader
  interface.
- The **`ratel-cloud` product row**: 0014 defined it as "a managed multi-tenant deployment of
  the OSS server." With no OSS server, `ratel-cloud` is a **first-class catalog source that
  implements the `protocol/` contract directly**.
- **One-API-two-transports is reinterpreted, not dropped:** the principle stands (embedded FFI
  vs remote, app code unchanged), but the remote transport is a **source loader over a
  source-compatibility contract**, not a bespoke client of a "server protocol" (0014's phrase).
- The **adoption gradient's shape stands** (in-process → local → self-hosted → cloud) as
  *direction*, but its "self-hosted server" rung is **deferred**, and the cloud rung is a
  standalone catalog source, not "a deployment of the same OSS server."
- The **small decisions** naming `src/server` / `ratel-ai-server` / `ratel-server` /
  `@ratel-ai/server` as things built in Phase 4: reserved, not built.
- 0014's amendment to [ADR-0010](0010-extract-mcp-server-to-ratel-mcp.md)'s **dependency
  direction** (the CLI→`@ratel-ai/mcp-server` dependency "inverts as server verbs land
  in-repo") is **also deferred** — no server verbs land, so ADR-0010's arrangement stands
  unchanged until/unless a server ships.

Untouched, and still `Accepted`: the **repo-boundary rule** (its "the server stays in-tree"
worked example is simply moot while the server is deferred, and applies again if one ships) and
the `ratel-mcp → ratel-local` identity reframe. The top-level `protocol/` folder also stays,
reframed from a server's wire protocol to a catalog-source contract.

## Consequences

- **One artifact, a smaller surface.** No server crate/binary/npm/release-unit to build,
  publish, or maintain in Phase 4 or 5. The Phase-3 release-infra collision disappears — there
  is no `server-v*` unit to add.
- **The road back is cheap for the skeleton, explicitly not for the value.** A future
  self-hosted server plugs into the same catalog-source contract *provided* `@ratel-ai/cloud`'s
  catalog half never diverges from `protocol/`. But the contract is the commodity rung only; the
  cloud's suggestion / analytics / ranking value is off-protocol and a faithful server would not
  inherit it. Opening any of that (the usage-ranking read model first — RCSR-5) is a separate,
  deliberate act.
- **Shared self-hosting and air-gapped are genuinely unavailable until the server ships** — not
  papered over by "write a loader." Positioning and sales must treat them as deferred
  capabilities with a named un-defer trigger, not as covered.
- **The `protocol/` contract's only server-side implementer today is the closed cloud.** To keep
  the closed product from silently becoming the de-facto spec, `protocol/v1` carries
  language-agnostic **conformance vectors** (fixture catalog → expected ETag, scope-overlay, 304
  semantics) the cloud and any loader/server MUST pass.
- **Forkable value stays in the engine and the intelligence, in library form** — not a CRUD
  server. If a server ships later it will be worth forking for what it bundles, not for existing.

## Rejected

- **Build `ratel-ai-server` now (ADR-0014 as written).** Spends Phase 4/5 effort on the
  speculative self-hosted tier, ships a CRUD-around-a-catalog nobody has asked to run, and
  duplicates the contract the cloud already implements. Deferred, not cancelled.
- **Make the cloud a private API and drop `protocol/`.** Cheapest short-term, but it forecloses
  the future server and any third-party loader; the published contract is the insurance policy
  for the catalog rung.
- **Kill the four-product vision entirely (library + cloud only, no protocol, no future
  server).** Over-corrects: it discards the gradient and the option value of self-hosting for a
  marginal further simplification. Keeping the source contract plus a deferred server preserves
  optionality at near-zero cost.
- **Ship a minimal reference server now anyway (a thin SQLite `protocol/v1` impl as the forkable
  seed).** Tempting as conformance anchor + self-host seed, but it re-introduces the build/
  maintain cost the pivot removes before any demand. Reconsider the moment a self-hosted or
  air-gapped deal is real; until then the conformance vectors, not a shipped server, keep the
  contract honest.
