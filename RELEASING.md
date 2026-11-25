# Releasing Ratel

## SDK packages

The SDK release units (`ratel-ai-core`, `@ratel-ai/sdk`, `ratel-ai`, the telemetry packages,
the framework adapters and the rankers plugin) moved to
[ratel-ai/ratel-sdk](https://github.com/ratel-ai/ratel-sdk), with their history, release
workflows and tooling. Read its
[RELEASING.md](https://github.com/ratel-ai/ratel-sdk/blob/main/RELEASING.md) to cut a release.

`@ratel-ai/mcp-server` ships from [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp).

## Platform

The platform (`web/`) is not published as a package. It is versioned as one unit with
[release-please](https://github.com/googleapis/release-please), and each release publishes the
OSS image `docker.io/ratelai/ratel` and the demo data image `docker.io/ratelai/ratel-demo`.
Every deploy path runs them at a pinned version (see [README.md](README.md)):
`docker-compose.build.yml` and `install.sh --ref` build from source instead.

### Versions

- Commit titles follow [Conventional Commits](https://www.conventionalcommits.org), enforced by the
  `pr-title` check on PR titles: `feat:` makes
  a minor release, `fix:` and `perf:` make a patch release, and `feat!:` or a `BREAKING CHANGE:`
  footer makes a major release (a minor release while the version is below 1.0.0). Other types
  (`refactor:`, `docs:`, `chore:`, `ci:`, `test:`) make no release on their own.
- On each push to `main`, `.github/workflows/release-please.yml` opens or updates one release PR,
  `chore(main): release X.Y.Z`. It bumps `version` in `package.json` and `web/package.json`,
  moves the default `RATEL_VERSION` in `docker-compose.yml` and `.env.example`, updates
  `.release-please-manifest.json` and writes `CHANGELOG.md`. Edit the PR body to change the
  release notes. A `Release-As: X.Y.Z` footer on a commit to `main` forces a version.
- Merge the release PR to release. release-please then tags `vX.Y.Z` on the merge commit and
  creates the GitHub Release.
- The config is `release-please-config.json`. The first release is `v0.3.0`, above the old SDK tags.
  It has no app image (its build failed), so the first published version is 0.3.1.

`install.sh` and `deploy.sh` take the highest `X.Y.Z` tag of `ratelai/ratel` on Docker Hub as the
latest release. They do not read git tags or GitHub releases: this repo has SDK releases named
`v0.1.4`, `v0.1.5`, `v0.1.6` and `v0.2.0`, which have no image. A platform release cannot reuse
those versions (release-please fails on a tag whose GitHub Release exists), so the platform starts
at 0.3.0. Between the merge of a release PR and the end of its image job, `docker compose up`
on `main` names a version that is not on Docker Hub yet.

A release PR that `GITHUB_TOKEN` opens starts no CI, so its required `ci-gate` and
`pr-title` checks never report. Store a fine-grained token (contents and pull requests: read and write) or a GitHub App
token in the `RELEASE_PLEASE_TOKEN` secret, and the workflow uses it. Until then, close and reopen
the release PR to start CI. With that token, the release tag push also starts `image.yml`: the
second run pushes the same tags again from the build cache.

### Images

`.github/workflows/image.yml` builds the `oss` target of `web/Dockerfile` for linux/amd64 and
linux/arm64 (arm64 under QEMU) and pushes `docker.io/ratelai/ratel`. It builds the `demo` target
and pushes `docker.io/ratelai/ratel-demo` with the same tags:

| Trigger | Tags |
| --- | --- |
| A release (the `image` job of `release-please.yml`) | `X.Y.Z`, `X.Y`, `latest` |
| A pushed tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, `latest` |
| A pushed tag `vX.Y.Z-rc.N` (a pre-release) | `X.Y.Z-rc.N` only |
| A push to `main` | `edge` |
| A manual run (`gh workflow run image.yml -f tag=<tag>`) | `<tag>` only |

The merge of a release PR cancels the older `edge` runs that are still in progress, because its own
`edge` run replaces them. An ordinary push to `main` waits for the run in progress. That merge
never cancels a release build, a tag build, a manual run or a `release-please.yml` run in progress.

Each image has OCI labels and annotations (source, revision, version, created, licenses), a
provenance attestation (`mode=max`) and an SBOM. Read them with
`docker buildx imagetools inspect ratelai/ratel:<tag> --format '{{ json .Provenance }}'` (or
`.SBOM`). After the push, the `smoke` job pulls the image, runs it on Postgres and waits for
`/api/health`.

The job logs in with the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets: a Docker Hub
access token with Read & Write on the `ratelai` namespace. The repositories `ratelai/ratel` and
`ratelai/ratel-demo` must be public.

### SDK versions

The platform uses the published SDK packages from npm: to take a new SDK version, bump
`@ratel-ai/sdk` and `@ratel-ai/telemetry` in `web/package.json` and `ee/package.json`.

Every change to `main` goes through the required `ci-gate` check in `.github/workflows/ci.yml` and
the `pr-title` check in `.github/workflows/pr-title.yml` ([ADR-0008](docs/adr/0008-single-ci-gate.md)).
