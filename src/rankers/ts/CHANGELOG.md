# Changelog

All notable changes to `@ratel-ai/rankers-plugin` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-rc.1] - 2026-10-16

### Added

- First release (ADR-0028). The vendor rankers move here from `@ratel-ai/sdk`:
  - `ratelJevPlugin({ url?, apiKeyEnv?, model? })` returns `{ retrieve, rerank }` for Jev (TypeSafe AI; key in `TYPESAFE_API_KEY`). It moved from `@ratel-ai/sdk` 0.13.0-rc.11.
  - `ratelOpenAIDecisionPlugin({ url?, apiKeyEnv?, model? })` does the same for OpenAI's Decisions API (public beta; key in `OPENAI_API_KEY`, model `gpt-6-luna`). A model refusal is the transient `RetrieverError` code `"Refused"`. The first plugin made prints a one-time beta warning; `RATEL_EXPERIMENTAL_SILENCE=1` silences it.
  - Both send the query and each candidate's searchable text to the vendor.
- `choiceRankerPlugin(ranker)`, the shared adapter, turns any object with `rankAsync(query, [{ id, text }], topK, kind)` into a plugin.
- Re-exports the SDK's plugin contract (`RankFn`, `RankCandidate`, `RankCandidateKind`, `RankedId`, `RetrieverError`, `RetrieverPlugin`, `definePlugin`). Peer-depends on `@ratel-ai/sdk` `*`, so any newer SDK, prereleases included, installs; it needs `0.13.0-rc.12` or later (`ratel.sdkFloor`).
