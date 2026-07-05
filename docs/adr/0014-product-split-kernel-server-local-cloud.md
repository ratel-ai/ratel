# 14. Product split: kernel / server / local / cloud

Date: 2026-07-04

## Status

Accepted

## Context

Ratel today is one thing wearing several hats: a Rust kernel (`ratel-ai-core`), TS/Python
SDKs that bind it in-process, a CLI, and `@ratel-ai/mcp-server` (extracted to the sibling
`ratel-ai/ratel-mcp` repo per [ADR-0010](0010-extract-mcp-server-to-ratel-mcp.md)). The docs
frame this as "a library, and an MCP server as the first showcase," and repeatedly promise
what Ratel is *not*: not a SaaS, no managed cloud, everything stays in-process. That framing
under-describes where the product is going and boxes out the deployments users actually ask
for — a shared self-hosted instance, a managed endpoint — while leaving the in-process library
exactly as it is.

The underlying architecture already supports more than "a library." One kernel decides what
enters an agent's context. The only real variable is *where that kernel runs and how the agent
reaches it*: linked into the agent process, behind a local daemon, behind a self-hosted server,
or behind a managed endpoint. Those are points on a single adoption gradient, not separate
products with separate cores. libSQL/Turso is the precedent: one engine shipped as an embeddable
library, a server, and embedded replicas that sync to a hosted service — same engine, one
protocol, all the way up.

Three forces make this the moment to name the split:

- **The server is now a decided thing.** A `ratel-ai-core`-wrapping HTTP server unlocks the
  shared-instance and managed-endpoint deployments. It does not exist yet, but the decision to
  build it is what this ADR records — and it changes where several existing boundaries sit.
- **`ratel-mcp` is mis-framed.** It reads as "the first showcase of the library." It is really
  the *local distribution of Ratel* — the shell that runs the engine in single-user mode with
  editor plugins, local UX, and daemon supervision. Naming it as such (`ratel-local`) clarifies
  the whole picture, but the package/binary/repo it ships under (`@ratel-ai/mcp-server` /
  `ratel-mcp`) is load-bearing for real installs, so the rename cannot happen now.
- **The SDK gains a remote transport.** Once a server speaks a protocol, the SDKs should be able
  to reach it — cloud, local daemon, or self-hosted — behind the *same* API as the embedded
  engine. [ADR-0002](0002-ts-rust-binding-strategy.md) and
  [ADR-0011](0011-python-rust-binding-strategy.md) each rejected "HTTP-only" as a shipping path.
  That rejection was aimed at a *different* thing — bare TS/Python talking to the core over HTTP
  as a way to dodge native artifacts — and it needs to be disentangled from the server protocol,
  which is a first-class shipping path.

Repo boundaries are the other open question. Everything sharing a monorepo maximizes atomic
refactors but drags unrelated audiences and toolchains through one release train; ejecting
everything to its own repo does the opposite. We need one rule that says when a component earns
its own repo, so this does not get re-litigated per component.

## Decision

### Four products, one kernel, one protocol

Ratel is four products with independent release cycles, over a single kernel and a single wire
protocol:

| Product | What it is | Ships as | Repo / status |
|---|---|---|---|
| **kernel** | The context-engineering engine: BM25 retrieval, tool selection, skills, trace events | `ratel-ai-core` crate + the TS/Python SDKs that bind it | this repo (OSS) |
| **server** | An HTTP server wrapping the kernel; speaks the wire protocol | `ratel-ai-server` crate / `ratel-server` binary / `@ratel-ai/server` | this repo (OSS); **decided here, not yet shipped** |
| **ratel-local** | The local distribution shell: single-user server mode, editor plugins, local UX, daemon supervision | today `@ratel-ai/mcp-server` / `ratel-mcp` | sibling `ratel-ai/ratel-mcp` (OSS) |
| **ratel-cloud** | Multi-tenant managed deployment of the OSS server + advanced analytics + catalog intelligence | hosted endpoint; SDKs reach it via `RATEL_URL` | closed, managed |

`ratel-bench` is unchanged (sibling repo; out of scope here).

### The adoption gradient

The four products are points on one gradient — **in-process SDK → local daemon → self-hosted
server → cloud** — sharing one kernel and one protocol:

- **In-process SDK.** The agent links the kernel directly (native FFI, per ADR-0002 / ADR-0011).
  No infra. This is and remains the floor.
- **Local daemon.** `ratel-local` runs the server in single-user mode on the developer's machine;
  editor plugins and local tooling talk to it over the protocol.
- **Self-hosted server.** A team runs `ratel-server` as shared infrastructure; agents reach it
  over the protocol.
- **Cloud.** `ratel-cloud` is the managed multi-tenant deployment of that same OSS server; SDKs
  reach it via `RATEL_URL`.

Each step up trades "zero infra" for "shared, managed, or centralized," and nothing forces the
step: the in-process library keeps working with no server anywhere. One kernel and one protocol
mean a graph tuned in-process behaves identically behind a daemon, a server, or the cloud.

### Repo-boundary rule

Default to the **monorepo**. A component ejects to its own repo only when **both** hold:

1. Its coupling to the rest of the repo has dropped to **protocol level** — it talks to Ratel
   over the wire protocol or a published package, not through shared source, a workspace link, or
   FFI; and
2. Its **toolchain and audience diverge** — different build stack, release cadence, and consumers.

Applied:

- **SDKs stay in-tree.** They bind the kernel through FFI (NAPI-RS / PyO3), a source-level,
  compile-time coupling to `ratel-ai-core`. That is above protocol coupling by construction, so
  the rule keeps them in the monorepo regardless of audience.
- **The server stays in-tree.** `ratel-ai-server` wraps `ratel-ai-core` directly, shares the Rust
  toolchain, and is co-developed with the kernel and protocol. No divergence, no eject.
- **`ratel-local` ejects** and stays ejected. It couples to Ratel at protocol level, runs an
  app/editor-plugin toolchain, and serves end users rather than SDK integrators — all three
  divergence conditions. This is exactly the eject [ADR-0010](0010-extract-mcp-server-to-ratel-mcp.md)
  already performed; naming it `ratel-local` does not move it back.
- **Cloud is closed**, in its own (private) repo; the closed/OSS boundary is itself a hard split.

### `ratel-mcp` → `ratel-local`: identity now, rename deferred

`ratel-mcp` / `@ratel-ai/mcp-server` **is** `ratel-local` — the local distribution of Ratel.
This ADR re-founds its *identity*: docs, positioning, and the mental model reframe it from "the
first showcase of the library" to "the local product in the four-product split," effective now.

The **package name, binary name, and repo slug rename is deferred to Phase 5.** Renaming
`@ratel-ai/mcp-server` → a `ratel-local` package (and the `ratel-mcp` binary/repo) breaks every
real install, editor-plugin config, and MCP-host entry pointing at the current names. The
identity reframe carries all the clarity; the rename carries all the breakage, so they are
sequenced apart. Until Phase 5, `@ratel-ai/mcp-server` / `ratel-mcp` remain the shipping names.

### One SDK API, two transports

The SDKs expose **one API surface** over **two transports**:

- **Embedded FFI** (the default, unchanged): the kernel linked in-process via NAPI-RS / PyO3.
- **Remote** via **`RATEL_URL`**: the same SDK surface talks the wire protocol to a server —
  `ratel-cloud`, a `ratel-local` daemon, or a self-hosted `ratel-server`. Cloud, local, and
  self-hosted are the *same protocol*; only the endpoint differs.

The choice is transport configuration, not two APIs: application code calling `search`, `invoke`,
`get_skill` does not change when `RATEL_URL` is set. Embedded stays the floor for zero-infra use;
remote is what makes the gradient continuous.

This remote transport **is a first-class shipping path** — it is the *server protocol*. That is
distinct from, and does not reopen, the "HTTP-only" path ADR-0002 and ADR-0011 rejected: that was
bare TS/Python speaking ad-hoc HTTP to the core as a way to *avoid native artifacts on unsupported
platforms*. The embedded transport is still native FFI on every supported platform; `RATEL_URL`
adds a deliberate remote mode against a real server, not a fallback to dodge the binding.

### Small decisions this ADR owns

- **Server folder is top-level `src/server`** (not nested under `src/core`). Crate
  **`ratel-ai-server`**, binary **`ratel-server`**, npm distribution **`@ratel-ai/server`**
  (platform packages, napi-style; the exact channel is finalized in Phase 4). The server is a
  peer product of the kernel, and the layout says so.
- **A top-level `protocol/` folder** holds the wire-protocol spec (created in Phase 4). It is a
  product surface, not a code module, so it sits at the repo top level beside `src/`.
- **The folder-README convention extends to top-level product folders.** The existing rule
  (every folder under `src/` and `docs/` carries a `README.md` describing only what is in it) now
  also covers top-level product folders such as `protocol/`. New top-level product folders add
  their README in the same change that creates them.
- **Name reservation:** `ratel-ai-cloud` is reserved defensively on crates.io and PyPI (the
  `@ratel-ai/*` npm scope is already owned). Low priority. The telemetry and server names get
  reserved naturally by their first RC publish (Phases 3 / 4). See
  [ADR-0016](0016-per-package-versions-and-releases.md) for the release units and tag scheme.

Telemetry direction (OTel conventions) is decided in
[ADR-0015](0015-telemetry-otel-conventions.md); the relicense of the kernel to Apache-2.0 (MIT
elsewhere) in [ADR-0017](0017-relicense-core-apache-2.md). This ADR names the products and
boundaries; those two carry their own decisions.

### Supersession

- **Partially supersedes [ADR-0010](0010-extract-mcp-server-to-ratel-mcp.md).** Two clauses:
  (a) the MCP-server *surface placement* framing — the extracted package is now `ratel-local`,
  the local product, not "the MCP surface / first showcase"; and (b) the **dependency direction**.
  ADR-0010 has `@ratel-ai/cli` depending on `@ratel-ai/mcp-server` and defers peeling the
  `mcp`/`serve`/`backup` verbs out of the CLI. As server verbs land in-repo (behind
  `ratel-ai-server`), that dependency inverts: the server story is owned in this repo, and the CLI
  no longer reaches *up* into the ejected package for it. ADR-0010's **core decision — the
  MCP-server package lives in the sibling `ratel-ai/ratel-mcp` repo — still holds**, so ADR-0010
  stays `Accepted`; only these two clauses are amended, here.
- **Partially supersedes [ADR-0002](0002-ts-rust-binding-strategy.md) and
  [ADR-0011](0011-python-rust-binding-strategy.md).** Only their "HTTP-only fallback is *not* a
  shipping path" clauses. Remote transport via `RATEL_URL` **is** a first-class shipping path now —
  but it is the *server protocol*, distinct from the bare "TS/Python-over-HTTP-to-the-core"
  contingency those ADRs rejected (a way to skip native artifacts on unsupported platforms). Their
  NAPI-RS / PyO3-default decisions are untouched; embedded FFI remains the default transport. Both
  ADRs stay `Accepted`; only the HTTP-shipping-path clause is amended, here.

## Consequences

- **The product story is coherent and honest.** Four named products on one gradient replace the
  "library plus a showcase, definitely not a SaaS" framing. The docs can describe direction (server
  coming, cloud managed) without contradicting what ships today.
- **The server is decided, not shipped.** `ratel-ai-server` / `ratel-server` / `@ratel-ai/server`
  do not exist yet; docs mark them roadmap and point at this ADR. Any "what ships today" surface
  keeps saying the server is not shipped and the cloud is not public.
- **`ratel-local` carries a name it does not yet publish under.** For the window between now and
  Phase 5, the identity is `ratel-local` but the artifacts are `@ratel-ai/mcp-server` / `ratel-mcp`.
  Docs must state both so nobody types a package name that does not resolve. The rename is a known,
  scheduled breakage — deferred precisely because it breaks installs.
- **The repo-boundary rule is now testable, not vibes.** "Protocol-level coupling AND diverging
  toolchain/audience" decides ejection. SDKs (FFI coupling) and the server (shared toolchain) stay;
  `ratel-local` (all three conditions) is out; cloud (closed boundary) is out. Future components get
  measured against the same two gates.
- **`RATEL_URL` commits us to protocol stability.** Making the remote transport first-class means
  the wire protocol is a compatibility surface across four products; `protocol/` and its versioning
  become load-bearing (Phase 4). The upside is one API for every deployment: application code does
  not fork between embedded and remote.
- **The CLI's dependency on the ejected package will invert.** As server verbs land in-repo, the
  CLI stops reaching up into `@ratel-ai/mcp-server` for server behavior. That refactor is scheduled,
  not done here; until it lands, ADR-0010's arrangement (`ratel mcp` / `serve` / `backup` running
  against published `@ratel-ai/mcp-server`) keeps working, so nothing user-visible breaks in the
  interim.
- **Execution is deferred by design.** This ADR records vision and boundaries. The path moves
  (`src/server`, `protocol/`), the relicense, per-package releases, and the OTel telemetry
  re-founding are executed in later phases under ADR-0015/0016/0017; this record does not create
  those files.

## Rejected

- **Keep the single-product "library + showcase" framing.** It is accurate about the floor and
  wrong about the direction: it forecloses the shared-instance and managed deployments users ask
  for, and forces "not a SaaS / no managed cloud" disclaimers that the server and cloud make false.
  Naming the four products costs a little discipline (keeping "decided" separate from "shipped") and
  buys a coherent story.
- **Full monorepo (pull `ratel-local` and cloud back in).** Atomic refactors, but it drags an
  end-user app toolchain and a closed-source product through one OSS release train, and recouples
  what ADR-0010 deliberately decoupled. The boundary rule keeps only genuinely-coupled components
  (SDKs, server) in-tree.
- **Full polyrepo (eject the SDKs and/or the server).** Independent cadence, but the SDKs bind the
  kernel through FFI and the server wraps it directly — both are source-and-toolchain coupled, so
  ejecting them buys cross-repo synchronization pain with no decoupling in return. They fail the
  protocol-coupling gate.
- **Rename `@ratel-ai/mcp-server` → `ratel-local` now.** Cleanest naming, but it breaks every real
  install, editor-plugin config, and MCP-host entry at once. The identity reframe delivers the
  clarity with zero breakage; the rename is deferred to Phase 5 where it can be sequenced and
  communicated.
- **Two SDK APIs — an embedded API and a separate remote client.** Explicit, but it forks
  application code by deployment and doubles the surface to learn and maintain. One API over two
  transports keeps the gradient continuous: flip `RATEL_URL`, not the code.
- **Treat `RATEL_URL` as the ADR-0002 / ADR-0011 "HTTP-only fallback."** They are different things.
  The rejected fallback was bare-language-over-HTTP to *avoid native artifacts*; the remote transport
  is a deliberate mode against a real server over the wire protocol, with embedded FFI still the
  default. Conflating them would either wrongly reopen those ADRs or wrongly demote the server
  protocol to a contingency.
