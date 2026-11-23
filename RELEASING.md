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
OSS image `docker.io/ratelai/ratel`. Operators can also build it from source with
`docker compose` (see [README.md](README.md)).

### Versions

- Commit titles follow [Conventional Commits](https://www.conventionalcommits.org), enforced by the
  `pr-title` check on PR titles: `feat:` makes
  a minor release, `fix:` and `perf:` make a patch release, and `feat!:` or a `BREAKING CHANGE:`
  footer makes a major release (a minor release while the version is below 1.0.0). Other types
  (`refactor:`, `docs:`, `chore:`, `ci:`, `test:`) make no release on their own.
- On each push to `main`, `.github/workflows/release-please.yml` opens or updates one release PR,
  `chore(main): release X.Y.Z`. It bumps `version` in `package.json` and `web/package.json`,
  updates `.release-please-manifest.json` and writes `CHANGELOG.md`. Edit the PR body to change the
  release notes. A `Release-As: X.Y.Z` footer on a commit to `main` forces a version.
- Merge the release PR to release. release-please then tags `vX.Y.Z` on the merge commit and
  creates the GitHub Release.
- The config is `release-please-config.json`. Its `release-as: 0.1.0` makes the first release
  `v0.1.0`: remove it in the PR after that release, or every later release PR stays at 0.1.0.

A release PR that `GITHUB_TOKEN` opens starts no CI, so its required `ci-gate` and
`pr-title` checks never report. Store a fine-grained token (contents and pull requests: read and write) or a GitHub App
token in the `RELEASE_PLEASE_TOKEN` secret, and the workflow uses it. Until then, close and reopen
the release PR to start CI. With that token, the release tag push also starts `image.yml`: the
second run pushes the same tags again from the build cache.

### Images

`.github/workflows/image.yml` builds the `oss` target of `web/Dockerfile` for linux/amd64 and
linux/arm64 (arm64 under QEMU) and pushes `docker.io/ratelai/ratel`:

| Trigger | Tags |
| --- | --- |
| A release (the `image` job of `release-please.yml`) | `X.Y.Z`, `X.Y`, `latest` |
| A pushed tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, `latest` |
| A pushed tag `vX.Y.Z-rc.N` (a pre-release) | `X.Y.Z-rc.N` only |
| A push to `main` | `edge` |
| A manual run (`gh workflow run image.yml -f tag=<tag>`) | `<tag>` only |

Each image has OCI labels and annotations (source, revision, version, created, licenses), a
provenance attestation (`mode=max`) and an SBOM. Read them with
`docker buildx imagetools inspect ratelai/ratel:<tag> --format '{{ json .Provenance }}'` (or
`.SBOM`). After the push, the `smoke` job pulls the image, runs it on Postgres and waits for
`/api/health`.

The job logs in with the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets: a Docker Hub
access token with Read & Write on the `ratelai` namespace. The repository `ratelai/ratel` must
be public.

### SDK versions

The platform uses the published SDK packages from npm: to take a new SDK version, bump
`@ratel-ai/sdk` and `@ratel-ai/telemetry` in `web/package.json` and `ee/package.json`.

Every change to `main` goes through the required `ci-gate` check in `.github/workflows/ci.yml` and
the `pr-title` check in `.github/workflows/pr-title.yml` ([ADR-0008](docs/adr/0008-single-ci-gate.md)).
