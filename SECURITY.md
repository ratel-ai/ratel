# Security policy

## Reporting a vulnerability

Please do not put the details of a security problem in a public issue.
[Open an issue](https://github.com/ratel-ai/ratel/issues/new) titled **Security contact request** with
no details, not even the affected package. A maintainer then opens a private draft security advisory
and invites you to it. Put the package and version, what the problem is, and how to reproduce it
there; a proof of concept helps.

What to expect:

- an acknowledgement within 3 business days;
- a first assessment, and where a fix will land, within 10 business days;
- a fix released as a patch of every supported version line below, with credit in the advisory
  unless you ask otherwise.

Please give us a reasonable time to ship the fix before you talk about the problem publicly.

## Supported versions

| Package | Supported |
|---|---|
| Ratel Platform (`web`) | `main` |

The SDK packages (`ratel-ai-core`, `@ratel-ai/sdk`, `ratel-ai`, the telemetry packages, the
framework adapters and the rankers plugin) live in
[ratel-ai/ratel-sdk](https://github.com/ratel-ai/ratel-sdk). Report a vulnerability in them
there; its `SECURITY.md` lists the supported versions.

## Scope

In scope: the platform at `web`, the packages in this repository, and the repository's
build tooling. A self-hosted platform is operated by whoever deploys it: putting the console behind
authentication or binding it to localhost is the operator's job (see `web/README.md`).

Out of scope: the hosted Ratel service and its private modules, which have their own
reporting channel.
