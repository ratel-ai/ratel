# 16. Per-package versions and releases

Date: 2026-07-04

## Status

Accepted

## Context

Today the repo releases in lockstep. A single Cargo `workspace.package.version` (`0.2.0`) is shared by every crate, the TS and Python manifests carry the same string, one `v*` tag drives the whole `release.yml`, and `tag-version-check` fails the workflow unless the workspace crate, `@ratel-ai/sdk`, `@ratel-ai/cli`, and `ratel-ai` all match the tag. ADR-0008 codified four lockstep artifacts; ADR-0010 narrowed that to three (after `@ratel-ai/mcp-server` left the repo); ADR-0011 aligned `ratel-ai` to the same workspace semver. One bump ships everything.

The product split (ADR-0014) breaks that. The repo now houses independently-evolving units — kernel, JS SDK, Python SDK, CLI, and soon telemetry helpers and a server — with different consumers, different cadences, and different reasons to move. Lockstep already forced no-op releases inside this repo before the split (a CLI-only fix riding a dead SDK bump, the exact tax ADR-0010 called out); with two more units landing it becomes untenable. A telemetry-conventions patch must not force a kernel version, and a kernel patch must not force a CLI republish.

Two hard constraints shape the move away from lockstep:

- **The publish trust is bound to the workflow, the environment name, and the package names.** We publish with OIDC **Trusted Publishers** — no long-lived `NPM_TOKEN` / `CARGO_REGISTRY_TOKEN` secrets. Each Trusted Publisher registration on npm / PyPI / crates.io names an owning repo, workflow **filename**, and the `release` GitHub **environment**. Nine registrations (the npm loader + five platform packages + CLI on npm, the `ratel-ai` wheel on PyPI, and the `ratel-ai-core` crate on crates.io) are bound to `release.yml` and the `release` environment. Renaming the workflow or the environment de-registers all of them.
- **The environment's deployment tag policy and the workflow trigger must agree.** `on.push.tags` is `['v*']` and the `release` environment only permits `v*` refs to deploy. A per-unit tag scheme has to change both, together.

## Decision

### Per-package versions, per-unit tags

Drop the shared workspace version. Each release unit carries its own version and ships on its own tag prefix.

| Unit | Contents | Tag prefix | Phase |
|---|---|---|---|
| `ratel-ai-core` | the kernel crate | `core-v*` | now |
| JS SDK | `@ratel-ai/sdk` loader + 5 platform packages + the `ts-native` crate — **internally lockstep** | `sdk-js-v*` | now |
| Python SDK | `ratel-ai` (PyPI) + the `py-native` crate | `sdk-py-v*` | now |
| CLI | `@ratel-ai/cli` | `cli-v*` | now |
| Telemetry | the telemetry helper packages — one independent unit **per registry** (no cross-package lockstep) | `telemetry-*-v*` (per package) | reserved, Phase 3 |
| Server | `ratel-ai-server` + `@ratel-ai/server` | `server-v*` | reserved, Phase 4 |

A tag is `<prefix>-vX.Y.Z` (GA) or `<prefix>-vX.Y.Z-rc.N` (RC). The telemetry and server prefixes are reserved, not live jobs — they ship when Phases 3/4 land those folders. What counts as a *unit* is decided by the per-package principle above, not by a fixed tag name: the telemetry helpers have no cross-registry install dependency to force lockstep, so they finalize as one independent unit per registry — each on its own `telemetry-*-v*` prefix — rather than a single bundled tag.

### The JS SDK unit is internally lockstep

`sdk-js-v*` releases seven artifacts as one atomic unit: the `@ratel-ai/sdk` loader, the five per-platform native packages, and the `ts-native` crate they wrap. They **must** share a version — the loader's `optionalDependencies` pin each platform package to its exact version, and a loader that resolves to a platform binary built from a different core is a silent ABI mismatch. This is enforced mechanically by `scripts/inject-sdk-optional-deps.mjs`, which reads each platform package's version and **throws** if any differs from the loader before publish. Internal lockstep inside the JS unit is a correctness invariant; cross-unit lockstep is the thing we are abolishing.

### RC-first, OIDC Trusted Publishers

Every release ships as `<prefix>-vX.Y.Z-rc.N` first, promoted to GA only after the RC is exercised. Publishing stays on **OIDC Trusted Publishers** across all three registries — no long-lived registry tokens. RC builds publish under the `rc` dist-tag / pre-release channel; GA under `latest`. A new unit's *first* publish is a one-time manual push (the registry cannot bind a Trusted Publisher to a package that does not yet exist); every publish after that is workflow-driven.

### One `release.yml`, routed by tag prefix

Keep a **single `release.yml`**. Splitting it per unit would break all nine Trusted Publisher registrations, since each is bound to this exact workflow filename. Instead the workflow **routes by tag prefix**: `<prefix>-v*` selects which build/publish jobs run. `on.push.tags` widens from `['v*']` to the prefix set (`core-v*`, `sdk-js-v*`, `sdk-py-v*`, `cli-v*`, and later the telemetry helper prefixes and `server-v*`), and a job gates on the parsed prefix so a `core-v*` tag never runs the npm publish path, and vice versa.

### Keep the `release` environment name; update only its tag policy

Keep the GitHub environment **named `release`** — the Trusted Publishers bind to that name and renaming it de-registers them. Change only its **deployment branch/tag policy**, from `v*` to the prefix set, so the widened `on.push.tags` and the environment agree on which tags may deploy. This is a repository-settings change made outside git, executed in **Phase 2** alongside the workflow edit; the two must land together or every non-`v*` tag either fails to trigger or fails to deploy.

### Per-unit tag-version-check + CHANGELOG gate

`tag-version-check` becomes **per-unit**. It parses the prefix, and for the selected unit only:

- verifies every manifest in that unit matches the tag's `X.Y.Z` (for `sdk-js` that is the loader, all five platform packages, and the `ts-native` crate; PyPI's PEP 440 normalization of `-rc.N` is still accepted, per the existing check);
- verifies that unit's `CHANGELOG.md` files carry a `## [X.Y.Z]` heading, failing the release if any is missing.

The per-package CHANGELOG **mechanism** from ADR-0008 (git-cliff drafts, the `/changelog` skill, the GA-collapse rule, the CI block) is unchanged; only the "one tag gates all four CHANGELOGs at once" wiring is replaced by "each tag gates its own unit's CHANGELOGs."

### CLI publish guard

`@ratel-ai/cli` depends on `@ratel-ai/sdk` via `workspace:^`, which `pnpm pack` rewrites to a concrete semver range at publish time. Decoupling the versions makes that rewrite a live hazard: a `cli-v*` release can now be cut against an SDK version that is not yet on npm, or a **GA CLI can pack a range that resolves to an `rc` SDK**. The `cli` publish job gates on two CI checks before it publishes:

1. the rewritten `@ratel-ai/sdk` range **resolves to a published version on npm** (the CLI never ships a dangling dependency);
2. a **GA** `cli-v*` release resolves that range to a **GA** SDK, never a `-rc.*` one (a stable CLI never packs a pre-release core).

An RC CLI may pack an RC SDK; a GA CLI may not. The guard fails the release before the immutable publish, not after.

## Consequences

- Units release on their own clock. A kernel patch ships `core-vX.Y.Z` alone; a docs-only CLI fix ships `cli-vX.Y.Z` without touching the SDK. The no-op-bump tax ADR-0010 named is gone.
- **Versions diverge, and that is intended.** After the first independent release the units no longer share a number; "the Ratel version" stops being a single value. Consumers pin per package, and cross-unit compatibility is expressed by dependency ranges (the CLI's SDK range, the SDK loader's platform pins), not by a shared semver.
- **One workflow, more branching.** `release.yml` grows a prefix-routing layer and per-unit gates instead of a single linear pipeline. The payoff is that the nine Trusted Publisher registrations and the `release` environment survive untouched — the highest-risk thing to break in a release system.
- **The environment tag-policy edit is invisible in git and load-bearing.** It lives in repo settings, lands in Phase 2 with the workflow change, and if forgotten, tagged releases silently fail to deploy. It is called out here so the Phase 2 executor cannot miss it.
- **The JS SDK's internal lockstep is now the *only* lockstep left**, and it is a correctness guarantee (matching ABI), not a release-coupling convenience. The inject script is the enforcement point; loosening it would ship mismatched binaries.
- **RC-first plus OIDC is preserved verbatim across the split** — no new secrets, no per-unit token sprawl. The cost is one manual first publish per new unit (`telemetry`, `server`) to seat its Trusted Publisher.
- **The CLI guard trades a little release friction for a real safety property**: no published CLI can ever resolve to a missing or pre-release SDK. Cutting a CLI release now requires its SDK dependency to already be live at the right channel.

### Amendments

This ADR amends three still-`Accepted` ADRs on their lockstep-versioning clauses only. No prior ADR is superseded; each stays authoritative on everything else it decided.

- **ADR-0008** — amends its "four lockstep artifacts" framing (already narrowed to three by ADR-0010). Artifacts no longer share a version or a tag. The per-package CHANGELOG mechanism it defines is untouched and still in force.
- **ADR-0010** — amends its Decision clause 3 ("this repo publishes three lockstep artifacts") and the matching `tag-version-check` / CHANGELOG-gate consequences. The units and their gates are now per-tag. ADR-0010's core decision (the MCP server lives in the sibling repo) is unaffected.
- **ADR-0011** — amends its final consequence ("`ratel-ai` ships at the same workspace semver as `ratel-ai-core`, `@ratel-ai/sdk`, and `@ratel-ai/cli`; the release pipeline enforces it"). `ratel-ai` now versions and tags independently (`sdk-py-v*`). The PyO3 + maturin binding decision itself is unaffected.

## Rejected

- **Stay lockstep.** Simple to reason about, one tag, one version — but it forces no-op releases across unrelated units and gets worse with every unit the product split adds. The tax already bit before the split (ADR-0010); five-plus units makes it prohibitive.
- **One workflow file per unit** (`release-core.yml`, `release-sdk-js.yml`, …). Cleaner routing, but every Trusted Publisher registration is bound to a workflow **filename**; splitting the file de-registers all nine and forces re-registration on every registry. Prefix-routing inside one file keeps the trust intact.
- **Rename the `release` environment per unit** (or drop the environment gate). The environment name is part of the Trusted Publisher binding; renaming it breaks OIDC publishing. Keeping the name and editing only its tag policy is the minimal change that keeps the trust seated.
- **Long-lived registry tokens instead of OIDC.** Would sidestep the workflow/environment-name coupling entirely, but reintroduces stored `NPM_TOKEN` / `CARGO_REGISTRY_TOKEN` secrets — the exact posture the RC-first / Trusted-Publisher release model exists to avoid.
- **Drop RC-first for the fast-moving units.** Tempting for a kernel-only patch, but the RC gate is what catches a bad publish before an immutable version goes live on three registries. Kept for every unit.
- **Let the CLI pack whatever range `workspace:^` rewrites to.** Zero extra CI, but a GA CLI could ship pinned to an unpublished or `-rc.*` SDK, breaking `npm install` or leaking a pre-release into a stable line. The publish guard is cheap insurance against an immutable mistake.
