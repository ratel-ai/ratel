# Releasing — SDK update methodology

How to cut a release of the Ratel library. The Rust core, both SDKs, and the CLI ship as **one version, together** — a coordinated release. This is the runbook.

## The coordinated-version invariant

`ratel-ai-core` (crate), `@ratel-ai/sdk` (npm), `ratel-ai` (PyPI), and `@ratel-ai/cli` (npm) **always share a single version**, equal to the release tag. The release workflow (`.github/workflows/release.yml`, job `tag-version-check`) refuses to publish unless all of them match the `vX.Y.Z` tag. There is no "publish just the TS SDK" — **a version number means the same feature set in every language.**

The version sources that must all read `X.Y.Z`:

| Artifact | File | Field |
|---|---|---|
| Rust core (+ both native crates, via `version.workspace = true`) | `Cargo.toml` | `[workspace.package] version` |
| TS SDK | `src/sdk/ts/package.json` | `version` |
| TS SDK platform packages (×5) | `src/sdk/ts/npm/*/package.json` | `version` |
| CLI | `src/integrations/cli/package.json` | `version` |
| Python SDK | `src/sdk/python/pyproject.toml` | `[project] version` |

The workflow checks the core/sdk/cli/python four; the 5 `npm/*` packages aren't checked but publish alongside the loader, so keep them in lockstep.

## Semver policy

Versioned against the **public SDK surface**: the gateway tools, exported symbols, and the model-facing tool names + JSON schemas. Pre-1.0, a breaking change bumps the **minor**.

| Bump | When | Example |
|---|---|---|
| **Breaking** (`0.1.x → 0.2.0`) | Rename/remove a gateway tool or exported symbol; change a tool's input/output schema incompatibly; change the model-facing contract. | `0.2.0` renamed `search_tools` → `search_capabilities` and changed the result to `{ tools, skills }`. |
| **Minor** (`0.x.0`) | Additive: new gateway tool, exported type, or optional field; no break. | Adding `get_skill_content` / a skills bucket, on its own. |
| **Patch** (`0.0.x`) | Bug fix, perf, docs — no surface change. | `isError` on error payloads. |

> ⚠️ **Published versions are immutable.** npm and PyPI never allow re-publishing a version. A new release must use a *higher* number than anything already on the registries — check `npm view @ratel-ai/sdk version` and `pip index versions ratel-ai` first. _(This is what blocked the skills branch: its source still said `0.1.5` while `0.1.6` was already published with the old API.)_

## Pre-release checklist (on the release PR)

1. **Bump every version source** to the target `X.Y.Z` (table above + the 5 `npm/*` packages), then refresh the lockfile: `cargo update -p ratel-ai-core --precise X.Y.Z`.
2. **Update all four CHANGELOGs** — add a `## [X.Y.Z] - YYYY-MM-DD` section to `src/core/lib`, `src/sdk/ts`, `src/sdk/python`, `src/integrations/cli`. The workflow **fails** if any is missing the entry (it greps for `## [X.Y.Z]`). Keep-a-Changelog format; note **BREAKING** changes explicitly.
3. **Green CI** — Rust (`fmt` / `clippy -D warnings` / `test`), TS (`pnpm -r build/typecheck/lint/test`), Python (`maturin develop` + `pytest` / `ruff` / `mypy --strict`), and the `example` workflows.
4. **Doc + example sweep** — if the surface changed, grep the old names out of READMEs and examples (they ship with the package; example imports are CI-run, so a stale import fails the `example` check).
5. **Merge to `main`.**

## Cutting the release

The pipeline is **tag-driven**. With the version + CHANGELOG commit on `main`:

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

`release.yml` then runs on the `v*` tag:

1. **`tag-version-check`** — verifies core/sdk/cli/python versions == tag and every CHANGELOG has the `## [X.Y.Z]` entry. Picks the npm dist-tag: `latest`, or `rc` for an `-rc.N` tag.
2. **`build`** — cross-builds the native binary for all five targets (`darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-arm64-gnu`, `win32-x64-msvc`) via napi; Python wheels are abi3 (Python ≥ 3.9).
3. **`publish-npm`** — distributes the binaries into the `npm/*` subpackages, injects `optionalDependencies` into the loader (`scripts/inject-sdk-optional-deps.mjs`), and publishes the 5 platform packages + the `@ratel-ai/sdk` loader (`--provenance`, `--tag <dist_tag>`). The CLI publishes the same way.
4. **`publish-pypi` / `publish-crates`** — maturin builds + uploads the `ratel-ai` wheels to PyPI; `cargo publish` pushes `ratel-ai-core` to crates.io.

### Pre-releases (RC)
Tag `vX.Y.Z-rc.N`. The workflow maps `-rc.N` → npm dist-tag `rc` (so `latest` doesn't move) and the PEP 440 form `X.Y.ZrcN` on PyPI; set `pyproject.toml` to the PEP 440 string (the check accepts either form).

### Dry run
`workflow_dispatch` with `dry_run: true` runs the whole pipeline with `--dry-run` on the publish steps — validate a release without publishing.

## Downstream coordination (`ratel-ai/ratel-mcp`)

`@ratel-ai/mcp-server` and the `ratel-mcp` CLI consume the **published** `@ratel-ai/sdk`. After an SDK release:

1. **Publish `@ratel-ai/sdk@X.Y.Z` first** (this repo).
2. In `ratel-mcp`, **bump the `@ratel-ai/sdk` dependency to `X.Y.Z`** — pin it, don't leave a `^` range that can float onto a newer-but-incompatible version (`^0.1.5` floats to `0.1.6`).
3. Un-draft / re-run the dependent PR; its CI goes green once the new SDK is on npm.

> For a **breaking** SDK release, the ratel-mcp PR's CI is red until the new SDK publishes — that red is the dependency lag, not a defect. Land + publish the SDK, then bump the consumer.

## Quick reference — bump

Files to edit (illustrative `sed`; on Linux drop the `''` after `-i`):

```bash
V=X.Y.Z
sed -i '' "s/^version = \"[0-9][0-9.]*\"/version = \"$V\"/" Cargo.toml src/sdk/python/pyproject.toml
sed -i '' "s/\"version\": \"[0-9][0-9.]*\"/\"version\": \"$V\"/" \
  src/sdk/ts/package.json src/sdk/ts/npm/*/package.json src/integrations/cli/package.json
cargo update -p ratel-ai-core --precise "$V"
# then: add ## [X.Y.Z] entries to the four CHANGELOGs → commit → PR → merge → tag vX.Y.Z
```
