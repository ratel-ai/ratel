# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through
GitHub's vulnerability reporting on this repository: **Security › Report a vulnerability**
(`https://github.com/ratel-ai/ratel/security/advisories/new`). Include the package and version,
what the problem is, and how to reproduce it; a proof of concept helps.

What to expect:

- an acknowledgement within 3 business days;
- a first assessment, and where a fix will land, within 10 business days;
- a fix released as a patch of every supported version line below, with credit in the advisory
  unless you ask otherwise.

Please give us a reasonable time to ship the fix before you talk about the problem publicly.

## Supported versions

Each package versions and releases independently (ADR 0008). Security fixes go to the latest
release line of each package tag family; older lines are not patched.

| Package | Tag family | Supported |
|---|---|---|
| `ratel-ai-core` (Rust) | `core-v*` | latest minor |
| `@ratel-ai/sdk` | `sdk-ts-v*` | latest minor |
| `ratel-ai` (Python) | `sdk-py-v*` | latest minor |
| `@ratel-ai/rankers-plugin` | `rankers-ts-v*` | latest minor |
| `ratel-ai-rankers-plugin` | `rankers-py-v*` | latest minor |
| Telemetry (Rust core, TypeScript, OTLP exporter, Python) | `telemetry-core-v*`, `telemetry-ts-v*`, `telemetry-ts-otlp-v*`, `telemetry-py-v*` | latest minor |
| Framework adapters | `mastra-v*`, `vercel-ai-sdk-v*` | latest minor |
| Ratel Platform (`apps/web`) | unreleased | `main` |

A release candidate (`-rc.N`) is supported until the release it precedes ships.

## Scope

In scope: the packages above, the platform at `apps/web`, and the repository's build and release
tooling. A self-hosted platform is operated by whoever deploys it: putting the console behind
authentication or binding it to localhost is the operator's job (see `apps/web/README.md`).

Out of scope: the hosted Ratel Cloud service and its private modules, which have their own
reporting channel.
