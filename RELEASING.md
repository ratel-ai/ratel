# Releasing Ratel

## SDK packages

The SDK release units (`ratel-ai-core`, `@ratel-ai/sdk`, `ratel-ai`, the telemetry packages,
the framework adapters and the rankers plugin) moved to
[ratel-ai/ratel-sdk](https://github.com/ratel-ai/ratel-sdk), with their history, release
workflows and tooling. Read its
[RELEASING.md](https://github.com/ratel-ai/ratel-sdk/blob/main/RELEASING.md) to cut a release.

`@ratel-ai/mcp-server` ships from [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp).

## Platform

The platform (`apps/web`) is not published as a package. It ships from `main`, and operators
build it with `docker compose` (see [README.md](README.md)). It uses the published SDK
packages from npm: to take a new SDK version, bump `@ratel-ai/sdk` and `@ratel-ai/telemetry`
in `apps/web/package.json` and `ee/package.json`.

Every change to `main` goes through the single required `ci-gate` check in
`.github/workflows/ci.yml` ([ADR-0016](docs/adr/0016-single-ci-gate.md)).
