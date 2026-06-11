# Releasing Ratel

How a new version of Ratel is published to npm and crates.io. Read end-to-end before cutting a release.

## What gets published

| Artifact | Registry | What it is |
|---|---|---|
| `ratel-ai-core` | crates.io | Rust library — BM25 tool retrieval algorithm. |
| `@ratel-ai/sdk-darwin-arm64` | npm | Per-OS native `.node` binary. |
| `@ratel-ai/sdk-darwin-x64` | npm | Per-OS native `.node` binary. |
| `@ratel-ai/sdk-linux-x64-gnu` | npm | Per-OS native `.node` binary. |
| `@ratel-ai/sdk-linux-arm64-gnu` | npm | Per-OS native `.node` binary. |
| `@ratel-ai/sdk-win32-x64-msvc` | npm | Per-OS native `.node` binary. |
| `@ratel-ai/sdk` | npm | TypeScript loader; `optionalDependencies` resolves the right per-OS subpackage on install. |
| `@ratel-ai/cli` | npm | The `ratel` CLI. |

`@ratel-ai/mcp-server` ships from a sibling repo, [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp), on its own release cadence. `@ratel-ai/cli` consumes the published artifact as a regular npm dependency.

## How the release pipeline is wired

- **`build-binaries.yml`** — workflow_dispatch only. Builds `.node` binaries on each of the five platforms and bundles all 7 npm tarballs into a downloadable `release-tarballs` artifact. Used for the very first manual publish (when no Trusted Publisher relationship exists yet) and for ad-hoc binary builds.
- **`release.yml`** — fires on every `v*` tag push (and supports `workflow_dispatch` with `dry_run: true` for rehearsal). Builds the matrix, publishes every artifact with provenance, creates a GitHub Release. Authentication is via Trusted Publishers (OIDC) — no `NPM_TOKEN` / `CARGO_REGISTRY_TOKEN` secrets stored in the repo. `*-rc.*` tags publish under the `rc` dist-tag; un-suffixed tags become `latest`.
- **`verify-install.yml`** — workflow_dispatch + daily cron. Installs the published packages on each of the five platforms with no Rust toolchain present and exercises the binding loader. Run after every release.

## Pre-merge gate (catch breakage before it lands)

`release.yml` only builds the real distributables at tag time, and `verify-install.yml`
only smoke-tests them *after* publishing. To catch packaging breaks (missing `files`,
`optionalDependencies` injection, sdist/twine metadata, native-binding load, cross-SDK
drift) **before** they reach `main`, `pr-gate.yml` shifts that validation onto the PR.

- **Opt-in to save CI.** The heavy jobs only run when a PR carries the **`ready-to-merge`**
  label (and re-run on every new commit while it stays on). Unlabeled PRs spend zero
  build minutes — the jobs are skipped.
- **Mandatory to merge.** The terminal `pr-gate` check is required on `main`. It **fails**
  any PR without the `ready-to-merge` label (so unlabeled PRs cannot merge), and on a
  labeled PR it goes green only when the whole pipeline is green.
- **Emergency override.** Adding the **`override-checks`** label forces `pr-gate` green even
  when the checks are RED, so the PR can be merged anyway. The gate still runs and shows the
  real (red) results, and emits a loud warning. By **convention this is rstagi-only and for
  emergencies** — GitHub can't restrict who applies a label or who merges, so it's a process
  rule, not a hard control. There are deliberately **no ruleset bypass actors**: the override
  is the label, not a privileged user (so "even rstagi has a block" — he must add the label).
- **What it runs:** one **`verify` job per platform** that builds the real distributables
  (wheel, npm loader + native binding, CLI tarball) and **installs each into a clean
  environment and runs the cross-SDK E2E** (`e2e/` — Python wheel, TS loader+native, CLI;
  the CLI installs the PR-built SDK, not the registry, so it stays correct on version-bump
  PRs), plus a single **`packaging` job** for the platform-independent checks (sdist +
  `twine check`, `cargo publish --dry-run`, npm `optionalDependencies` injection + cli
  pack). The Python and TS runners assert the same `e2e/scenario.json`, so a behavior
  divergence fails exactly one. (Kept to few check rows: each platform is one row;
  platforms run in parallel.)
- **Matrix (cost control):** armed-PR commits run a **reduced** matrix (`linux-x64` +
  `darwin-arm64` — the fast native runners). The **full 5-platform** matrix (adding Windows,
  `linux-arm64` cross-compile, `darwin-x64` Rosetta) runs on **push to `main` + nightly** —
  the same safety-net role `verify-install.yml` plays. So a platform-specific break surfaces
  right after merge / overnight, not on every PR commit. (`workflow_dispatch` runs the full
  matrix on demand.)

Developer flow: open a PR → fast `rust/ts/python` checks run as usual → when ready to land,
add the `ready-to-merge` label → the gate runs on every commit → merge once `pr-gate` is
green. If the gate is red and the merge truly can't wait, rstagi adds `override-checks` to
force it green and merges (sparingly).

Enable the required check + create both labels once (repo-admin):
`scripts/setup-branch-ruleset.sh`. Run the E2E locally per `e2e/README.md`.

## Cutting a release

### Once-per-repo prep (already done; do not redo)

- `@ratel-ai` npm org exists; the publishing account is a member with `developer`+ role; 2FA enabled.
- `ratel-ai-core` crate name is registered on crates.io.
- Trusted Publishers are configured on each of the 7 npm packages and the 1 crate, all pointing at this repo / `release.yml` / `release` environment.
- A `release` GitHub Environment exists, restricted to `v*` tags.

### Per-release flow

1. **Bump versions everywhere** to the new value (e.g. `0.1.4-rc.2`, then later `0.1.4`):
   - `Cargo.toml` (workspace `version` field)
   - `src/sdk/ts/package.json` (`version` only — `optionalDependencies` is not stored in source; it is injected at pack/publish time by `napi pre-publish`, which reads `napi.targets` and writes the block referencing each `npm/<triple>/package.json` version)
   - `src/integrations/cli/package.json` (`version`)
2. **Verify locally** before tagging:
   - `cargo publish -p ratel-ai-core --dry-run --allow-dirty`
   - `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`
   - For each ts package: `pnpm pack --dry-run` and inspect `package.json` inside the would-be tarball — workspace-deps must rewrite to a real semver range.
3. **(Optional dry-run)** `workflow_dispatch` `release.yml` with `dry_run: true` to validate the auth + publish path end-to-end without consuming a version number.
4. **Commit, tag, push:**
   ```
   git commit -am "release: vX.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```
5. **Watch `release.yml`** to completion. Inspect the GitHub Release on success.
6. **Run `verify-install.yml`** with the new version to confirm cross-platform install.
7. **For RCs**: validate the package on a real machine (`npx -y @ratel-ai/cli@rc --help` from a terminal with no Rust on PATH). Iterate (`-rc.2`, `-rc.3`, …) until happy, then bump to the un-suffixed version and tag again to promote to `latest`.

## Sharp edges

- **`tag-version-check`** in `release.yml` will fail loudly if any manifest disagrees with the tag. If it fails, the rest of the pipeline is short-circuited and nothing publishes — fix the version in the offending manifest, push a new commit, and re-tag.
- **Never republish a version.** npm and crates.io both reject this. If a release goes wrong after partial publish, bump to the next version (`X.Y.Z+1` or `X.Y.Z-rc.N+1`) and re-tag.
- **`@ratel-ai/sdk` `optionalDependencies` are injected, not committed.** The block does not live in `src/sdk/ts/package.json` in source — `scripts/inject-sdk-optional-deps.mjs` writes it into the in-flight package.json right before pack/publish, reading each `npm/<triple>/package.json` for the subpackage name + version. Keeping it out of source prevents `pnpm install --frozen-lockfile` from failing on subpackages that don't yet exist on the registry. The script enforces that every subpackage version matches the loader version, so bumping releases is just "edit one version field, re-run the bump check, push the tag".
- **macOS x64 is cross-compiled from `macos-14`** (Apple Silicon). GitHub's `macos-13` (Intel) pool has very long queues — sometimes hours. Building `x86_64-apple-darwin` on `macos-14` with Rust's `--target` flag works because the Apple Silicon runners ship both SDKs. Don't switch back to `macos-13` unless you've confirmed the Intel pool latency has improved.
- **Linux arm64-gnu** uses NAPI-RS's `--use-napi-cross` (its prebuilt sysroot containers). Don't switch to QEMU/`cross` without verifying glibc compatibility.
- **`workspace:^` rewriting** must be done by `pnpm pack` / `pnpm publish` — `npm publish` ships the literal string `"workspace:^"` and breaks installs (`EUNSUPPORTEDPROTOCOL` on `npm install`). The release workflow packs `cli` with `pnpm pack` first (its `@ratel-ai/sdk` dep is `workspace:^`) and then publishes the resulting tarball with `npm publish` (so OIDC + provenance still work). Don't pin internal deps to exact versions in source — that breaks patch-version uptake without a re-release.

## First-time bootstrap

(Only run when registering a brand-new package that has never existed on the registry before — Trusted Publishers can't be configured for a package that doesn't exist yet.)

1. Trigger `build-binaries.yml` via `workflow_dispatch` to build the binaries.
2. Make sure `npm login` is set on your laptop (npm requires 2FA on the publishing account for first-publish of scoped public packages) and `cargo login` for crates.io.
3. Run `scripts/publish-rc.sh --from-run <run-id>` — it downloads the `release-tarballs` artifact, verifies all 7 expected tarballs are present, publishes them in dependency order (5 subpackages → loader → cli) with `--access public --tag rc`, then `cargo publish -p ratel-ai-core`. The script is idempotent (skips versions already on the registry), so a partial failure is safe to resume.
   - First-publish from a laptop ships **without provenance** (provenance requires GH Actions OIDC). That's expected for the bootstrap — once Trusted Publishers are configured, every subsequent release flows through `release.yml` with `--provenance`.
4. Configure Trusted Publishers on each registry name (npm web UI for the 7 packages + crates.io web UI for `ratel-ai-core`) pointing at `release.yml` in this repo, `release` environment.
5. Bump to next version (e.g. `-rc.2`), tag, push — `release.yml` should now publish via OIDC with no token errors. Validates the trust relationship.
