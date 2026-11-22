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

| Package | Supported |
|---|---|
| Ratel Platform (`src`) | `main` |

The SDK packages (`ratel-ai-core`, `@ratel-ai/sdk`, `ratel-ai`, the telemetry packages, the
framework adapters and the rankers plugin) live in
[ratel-ai/ratel-sdk](https://github.com/ratel-ai/ratel-sdk). Report a vulnerability in them
there; its `SECURITY.md` lists the supported versions.

## Scope

In scope: the platform at `src`, the packages in this repository, and the repository's
build tooling. A self-hosted platform is operated by whoever deploys it: putting the console behind
authentication or binding it to localhost is the operator's job (see `src/README.md`).

Out of scope: the hosted Ratel service and its private modules, which have their own
reporting channel.
