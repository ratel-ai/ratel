# 32. Ratel Platform licensing: MIT for the open-source server

Date: 2026-11-13

## Status

Accepted

Extends [ADR-0009](0009-licensing.md) to the platform. It does not change ADR-0009's table for the
engine, the SDKs, the telemetry helpers or the examples.

## Context

ADR-0009 predates the platform. The repository now also holds the self-hosted Ratel Platform: the
application in `apps/web` (`@ratel/platform`), the shared UI packages `packages/brand` and
`packages/design-system`, and the `ee/` manifest whose source is a separate private repository
(ADR-0029, ADR-0030). The root `LICENSE.md` is MIT and the application and both packages already
declare `"license": "MIT"`, but no decision covered them.

The platform is the open-source edition people install and run themselves. Ratel Cloud adds its
modules from the private repository; they are never in this repository or in the open-source image
(`check:boundary`, `check:private`).

## Decision

The open-source platform is **MIT**, like the rest of the repository outside the engine:

| Component | License |
|---|---|
| `apps/web` (`@ratel/platform`), the open-source server and its Docker image | MIT |
| `packages/brand`, `packages/design-system` | MIT |
| `ee/package.json` (a manifest only, `"private": true`) | not distributed as a package; no license field |
| `ee/src` (the Cloud modules) | proprietary, in the private `ratel-ai/ratel-platform` repository, not in this repository |

`LICENSE.md` at the root keeps carrying MIT; GitHub keeps detecting the repository as MIT. There is
no carve-out inside this repository: the proprietary code is a separate repository checked out at
`ee/src`, which the public `.gitignore` excludes.

ADR-0009's rule holds for the platform too: no AGPL, SSPL, BSL or other source-available or copyleft
license. The license can change later by a superseding ADR; already-published versions keep the
terms they shipped under.

## Alternatives considered

- **Apache-2.0, as the engine.** Its patent grant matters for a library others embed; the platform
  is an application people run, not a component they ship inside their products, so MIT's
  simplicity wins, as for the SDKs.
- **AGPL or a source-available license (BSL, SSPL)** to stop a third party from hosting the server
  as a service. Rejected for the reason ADR-0009 gives: the value Ratel defends is the managed
  cloud's intelligence and operations, and a restrictive license would slow the self-hosted adoption
  the open-source edition exists for.

## Consequences

- Self-hosters, contributors and downstream forks get the same terms as the SDKs.
- The MIT SDK and the Apache-2.0 engine the platform depends on are compatible with an MIT
  application; nothing in the dependency tree is more restrictive for a consumer.
- Anyone may host the open-source server; Ratel Cloud's private modules are not part of it.
