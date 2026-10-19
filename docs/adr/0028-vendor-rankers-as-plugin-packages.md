# 28. Vendor rankers ship as plugin packages, not in core

Date: 2026-10-16

## Status

Accepted

Amends [ADR-0027](0027-custom-retriever-and-reranker-functions.md) §5 (where the Jev and
OpenAI Decisions clients live). Follows the release-unit model of
[ADR-0008](0008-release-engineering.md) and the peer-range model of
[ADR-0020](0020-adapter-sdk-peer-floor.md).

## Context

ADR-0027 made ranking a function the SDK is handed (`RankFn`), so search knows no model's
interface. But the first two plugins built on that contract, Jev and OpenAI Decisions, put their
clients in `ratel-ai-core` (`jev.rs`, `openai_decision.rs`, `choice_ranker.rs`), and both SDKs
bound and wrapped them, with each binding repeating per-vendor classes. As a result:

- core's public API named vendors
- every build shipped every vendor
- each new vendor forced a lockstep release of core and both SDKs
- first-party plugins took a different path from third-party ones, which the contract was
  meant to make equal

## Decision

**1. A `ratel-ai-rankers` crate holds the vendors** (`src/rankers/core`):

- the shared choice/tournament/HTTP/error logic: `ChoiceRanker<B>`, `RankerError`, the limits
- one `ChoiceBackend` per vendor, each behind a cargo feature (`jev`, `openai-decision`)
- `ranker_for(vendor, config)`, which picks a backend at runtime so the bindings carry no
  per-vendor code

The crate defines its own `Candidate { id, text }` and does not depend on core. It is internal
(`publish = false`): the plugin packages build it from the workspace.

**2. Two plugin packages bind it**: `@ratel-ai/rankers-plugin` (napi, `src/rankers/ts`) and
`ratel-ai-rankers-plugin` (pyo3, `src/rankers/python`). Each exports:

- the vendor plugins (`ratelJevPlugin`, `ratelOpenAIDecisionPlugin`, and the Python equivalents)
- one shared adapter (`choiceRankerPlugin`), which wraps any object with a `rankAsync` / `rank`
  method
- the plugin contract, re-exported

**3. The SDK owns the contract.** `RankFn`, `RankCandidate`, `RankedId`, `RetrieverError`,
`RetrieverPlugin` and `definePlugin` / `define_plugin` live in the SDK. A catalog decides
whether a reranker failure falls back by checking whether the error is a `RetrieverError`
instance (Python catches it by class). A plugin's error must therefore be the SDK's class,
not a copy, so each plugin package depends on its SDK and never the reverse. TS declares this
as a peer dependency, Python as a requirement.

**4. Each plugin package is an independent release unit** (`rankers-ts-v*`, `rankers-py-v*`):

- Each depends on its SDK from a floor, the first SDK with `definePlugin` (`0.13.0-rc.12`).
  Python states it as a requirement, `ratel-ai>=0.13.0rc12,<1.0`, which admits later
  prereleases. TS peers on `"*"` and records the floor as `ratel.sdkFloor` in `package.json`,
  because npm only admits a prerelease when the range names one of the same version: a range
  such as `>=0.13.0-rc.12 <1.0.0` would reject `0.14.0-rc.1`, and `"*"` is the only peer npm
  treats as always satisfied.
- The crate is in both units' release paths.
- Publish order: the SDK, then the plugin. The release jobs check that the floor resolves on
  the registry before publishing.

**5. Core and the SDKs are vendor-free.** `ratelJevPlugin` / `ratel_jev_plugin` move to the
plugin packages; no shim is left behind. A shim would make the SDK depend on the plugin, which
reverses the dependency. The Jev plugin first shipped in sdk 0.13.0-rc.11, the core clients
and the OpenAI Decisions plugin never shipped, and 0.13.0 is not yet GA. So only RC users of
the Jev plugin change an import.

## Consequences

- A new vendor is a backend module behind a feature, plus one arm in `ranker_for`. It ships on a
  plugin release, with no core or SDK release.
- Plugin authors import from one package, and `definePlugin` makes the type checker enforce the
  `RankFn` signature. First- and third-party plugins use the same contract.
- A plugin carries both functions in both SDKs (`RetrieverPlugin.retrieve` and `.rerank` are
  required). A ranker for one stage is a plain `RankFn`, passed to the catalog directly.
- Two more release units, with seven more registry names (the npm loader, its five platform
  packages, and the PyPI project), each needing a Trusted Publisher and a manual first publish.
- A build of a plugin package still ships every enabled vendor. Splitting vendors into separate
  packages stays possible later without touching the SDKs.
- Rejected: keeping the clients in core behind cargo features. Core's public API would still
  name vendors, and adding one would still need a core release.
- npm does not check the TS floor at install. An SDK below it fails at import on the missing
  `RetrieverError` export, and a bare `@ratel-ai/sdk` resolves to the SDK's `latest` tag, which
  is below the floor until `0.13.0` is GA. While the floor is a prerelease, the documented install
  pins both packages: `npm install @ratel-ai/sdk@rc @ratel-ai/rankers-plugin@rc`.
- Rejected: lockstep versioning with the SDK. It brings back the coupled releases this ADR exists
  to remove.
