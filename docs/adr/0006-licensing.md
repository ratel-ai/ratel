# 6. Licensing: MIT, no copyleft

## Status

Accepted

## Context

This repository holds the self-hosted platform and its UI packages. People install and run
it; they do not embed it in their products. The value Ratel defends is the managed cloud's
intelligence and operations, not a license barrier around open-source code.

## Decision

| Component | License |
|---|---|
| `src` (`@ratel/platform`), the open-source server and its Docker image | MIT |
| `packages/brand`, `packages/design-system` | MIT |
| `ee/package.json` (a manifest only, `"private": true`) | not distributed; no license field |
| `ee/src` (the Cloud modules) | proprietary, in the private `ratel-ai/ratel-platform` repository, never in this repository |

`LICENSE.md` at the root carries MIT. Each manifest declares its own `license` field.

**No AGPL, SSPL, BSL or other copyleft or source-available license in this repository.** A
restrictive license would slow the self-hosted adoption the open-source edition exists for.
Only a later ADR changes this. Published versions keep the terms they shipped under.

The engine (`ratel-ai-core`) is Apache-2.0 for its patent grant, as a library others embed.
That decision belongs to [ratel-ai/ratel-sdk](https://github.com/ratel-ai/ratel-sdk).

## Consequences

- Self-hosters, contributors and forks get MIT terms.
- The platform depends on the MIT SDK and the Apache-2.0 engine. Both are compatible with an
  MIT application, and nothing in the tree is more restrictive for a consumer.
- Anyone may host the open-source server. The managed edition's private modules are not part of it.
