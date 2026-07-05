# 18. Defer the `@ratel-ai/cli` package

Date: 2026-07-04

## Status

Accepted

## Context

The product split (ADR-0014) carries `@ratel-ai/cli` — the `ratel` binary — as an auxiliary
component of the `ratel` platform. It is a thin orchestrator: it owns no engine, wrapping
`@ratel-ai/mcp-server` (gateway + config) and `@ratel-ai/sdk` (catalog) to manage MCP servers
across scopes, run the gateway over stdio, import Claude Code's MCP setup, and inspect
telemetry. Three facts make it the weakest unit to carry through the rest of the split:

- **Nothing in-repo depends on it.** It is a leaf: the SDKs, examples, and `@ratel-ai/mcp-server`
  do not import or spawn it. Its only consumers are end users of the `ratel` command and the CI
  legs that exercise it.
- **Its surface is exactly what the next phases re-found.** The CLI's verbs (`serve`, `mcp`,
  `backup`, `inspect`) overlap almost entirely with the server binary (Phase 4) and the
  `ratel-local` re-founding (Phase 5). ADR-0010 already scheduled peeling the `mcp`/`serve`/`backup`
  verbs out of the CLI, and ADR-0014 flagged that its dependency on `@ratel-ai/mcp-server` inverts
  as server verbs land in-repo. Its final shape is a downstream consequence of decisions those
  phases have not made yet.
- **It taxes the release system for unclear near-term value.** Per-package releases (ADR-0016)
  make the CLI a fourth release unit (`cli-v*`) and require a dedicated **CLI publish guard**
  (ADR-0016 §"CLI publish guard") solely because the CLI's `workspace:^` dependency on the SDK
  can resolve to a missing or pre-release version at pack time. That is real machinery in service
  of a package no one currently uses.

Rather than build the CLI publish guard and carry the unit through Phases 3–5, defer the CLI:
remove it from the repo now and reintroduce it from a later version once its use case is clear
(most likely after the server and `ratel-local` stories settle).

## Decision

**Remove `@ratel-ai/cli` from this repo.** Delete `src/cli/`, its `e2e/cli/` runner, and every
reference in the workspace config, release pipeline, changelog tooling, and docs.

- **Release units drop from four to three** — `core`, `sdk-js`, `sdk-py`. The `cli-v*` tag prefix,
  the `publish-cli` job in `release.yml`, and the `cli` unit in the per-tag `tag-version-check`
  gate are removed. The **CLI publish guard (ADR-0016) is moot and is not built.**
- **Trusted Publishers drop from nine to eight.** The `@ratel-ai/cli` npm Trusted Publisher
  registration goes **dormant** — it is not deleted from npm, so a future reintroduction can reuse
  the binding to `release.yml` + the `release` environment without a fresh first-publish dance for
  that name.
- **The published npm versions are left as-is.** `@ratel-ai/cli` stays on npm frozen at its last
  versions (GA `0.2.0`, in-flight `0.3.0-rc.2`); it is **not** `npm deprecate`d. When the CLI
  returns it will be revamped and versioned forward from a later number, under a new ADR.
- **The `ratel` platform currently ships no first-party CLI** — the kernel (`ratel-ai-core`) and the
  two SDKs (`@ratel-ai/sdk`, `ratel-ai`). MCP-management UX lives in `ratel-local`'s `ratel-mcp`
  CLI in the meantime.

## Consequences

- The release surface shrinks: three units, eight Trusted Publishers, no CLI publish guard, no CLI
  legs in `pr-gate.yml` / `verify-install.yml` / `build-binaries.yml`. Phases 3–5 inherit a smaller
  pipeline to extend.
- The `ratel` binary is no longer distributed from this repo. Users on `pnpm add -g @ratel-ai/cli`
  keep whatever version they pinned, but no new versions ship and the command is unmaintained until
  reintroduction. No deprecation notice is published (deliberate — see Decision).
- Reintroducing the CLI is a fresh decision: a new ADR, a new `src/cli`, and re-adding the `cli-v*`
  unit + its guard. If the dormant Trusted Publisher is left in place, no manual first-publish is
  needed to reseat it.

## Amendments

This ADR amends the **CLI-specific clauses** of prior still-`Accepted` ADRs. Each stays
authoritative on everything else it decided; only the parts naming `@ratel-ai/cli` as a live,
shipped unit are retired here.

- **ADR-0014** — the CLI is no longer a shipped component of the `ratel` product. The product split
  (kernel / server / local / cloud) and the adoption gradient are unaffected.
- **ADR-0016** — retires the `@ratel-ai/cli` / `cli-v*` release-unit row, drops the Trusted Publisher
  count from nine to eight, and **retires the entire "CLI publish guard" section** (it is not
  implemented). Per-package versioning, prefix routing, RC-first, and the single-`release.yml` /
  `release`-environment decisions stand unchanged for the remaining units.
- **ADR-0008** — removes `src/cli/CHANGELOG.md` from the per-package CHANGELOG set it enumerated
  (already narrowed once by ADR-0010). The CHANGELOG mechanism — git-cliff drafts, the `/changelog`
  skill, the GA-collapse rule, the CI gate — is unchanged; it simply covers one fewer package.
- **ADR-0010** — its follow-up to peel the `mcp`/`serve`/`backup` verbs out of `@ratel-ai/cli` is
  moot while the CLI is absent. The core decision (the MCP server lives in the sibling `ratel-mcp`
  repo) is unaffected.
- **ADR-0017** — the `@ratel-ai/cli` MIT row is inert while the package is absent; the per-component
  licensing (Apache-2.0 kernel, MIT elsewhere) is unchanged and applies when the CLI returns.

## Rejected

- **Keep the CLI and build the publish guard anyway.** Completes ADR-0016 as written, but spends CI
  machinery and Phase 3–5 carrying cost on a leaf package with no current consumers and a shape that
  the server / `ratel-local` phases will redefine. Cheaper to defer than to maintain in limbo.
- **`npm deprecate @ratel-ai/cli`.** The polite signal to would-be installers, but the package has
  no meaningful usage and will be revamped, not retired; a deprecation notice would misstate intent.
  Left untouched instead.
- **Delete the npm Trusted Publisher registration too.** Removing it is reversible but forces a
  manual first-publish to reseat the binding on reintroduction. Leaving it dormant costs nothing and
  keeps the return path frictionless.
