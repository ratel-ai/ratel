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
| `@ratel-ai/mcp-server` | npm | MCP server library. |
| `@ratel-ai/cli` | npm | The `ratel` CLI. |

## How the release pipeline is wired

- **`build-binaries.yml`** — workflow_dispatch only. Builds `.node` binaries on each of the five platforms and bundles all 8 npm tarballs into a downloadable `release-tarballs` artifact. Used for the very first manual publish (when no Trusted Publisher relationship exists yet) and for ad-hoc binary builds.
- **`release.yml`** — fires on every `v*` tag push (and supports `workflow_dispatch` with `dry_run: true` for rehearsal). Builds the matrix, publishes every artifact with provenance, creates a GitHub Release. Authentication is via Trusted Publishers (OIDC) — no `NPM_TOKEN` / `CARGO_REGISTRY_TOKEN` secrets stored in the repo. `*-rc.*` tags publish under the `rc` dist-tag; un-suffixed tags become `latest`.
- **`verify-install.yml`** — workflow_dispatch + daily cron. Installs the published packages on each of the five platforms with no Rust toolchain present and exercises the binding loader. Run after every release.

## Cutting a release

### Once-per-repo prep (already done; do not redo)

- `@ratel-ai` npm org exists; the publishing account is a member with `developer`+ role; 2FA enabled.
- `ratel-ai-core` crate name is registered on crates.io.
- Trusted Publishers are configured on each of the 8 npm packages and the 1 crate, all pointing at this repo / `release.yml` / `release` environment.
- A `release` GitHub Environment exists, restricted to `v*` tags.

### Per-release flow

1. **Bump versions everywhere** to the new value (e.g. `0.1.4-rc.2`, then later `0.1.4`):
   - `Cargo.toml` (workspace `version` field)
   - `src/sdk/ts/package.json` (`version` only — `optionalDependencies` is not stored in source; it is injected at pack/publish time by `napi pre-publish`, which reads `napi.targets` and writes the block referencing each `npm/<triple>/package.json` version)
   - `src/integrations/mcp-server/package.json` (`version`)
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
- **`@ratel-ai/sdk` `optionalDependencies` are injected, not committed.** The block does not live in `src/sdk/ts/package.json` in source — `napi pre-publish --skip-optional-publish` writes it into the in-flight package.json right before pack/publish, deriving the entries from `napi.targets`. Keeping it out of source prevents `pnpm install --frozen-lockfile` from failing on subpackages that don't yet exist on the registry. Each `npm/<triple>/package.json`'s `version` must match the loader's; the bump-version step keeps them in sync.
- **macOS x64 is cross-compiled from `macos-14`** (Apple Silicon). GitHub's `macos-13` (Intel) pool has very long queues — sometimes hours. Building `x86_64-apple-darwin` on `macos-14` with Rust's `--target` flag works because the Apple Silicon runners ship both SDKs. Don't switch back to `macos-13` unless you've confirmed the Intel pool latency has improved.
- **Linux arm64-gnu** uses NAPI-RS's `--use-napi-cross` (its prebuilt sysroot containers). Don't switch to QEMU/`cross` without verifying glibc compatibility.
- **`workspace:^` rewriting** is handled by `pnpm pack` / `pnpm publish` automatically. Don't pin internal deps to exact versions in `package.json` — that breaks patch-version uptake without a re-release.

## First-time bootstrap

(Only run when registering a brand-new package that has never existed on the registry before — Trusted Publishers can't be configured for a package that doesn't exist yet.)

1. Trigger `build-binaries.yml` via `workflow_dispatch` to build the binaries.
2. Download the `release-tarballs` artifact, extract.
3. Manually `npm publish <tarball> --access public --tag rc --provenance` for each (subpackages first, then loader, then mcp-server, then cli). Requires `npm login` + 2FA.
4. `cargo publish -p ratel-ai-core` from local checkout.
5. Configure Trusted Publishers on each registry name (npm web UI + crates.io web UI) pointing at `release.yml` in this repo, `release` environment.
6. Bump to next version (e.g. `-rc.2`), tag, push — `release.yml` should now publish via OIDC with no token errors. Validates the trust relationship.
