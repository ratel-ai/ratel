# Changelog

All notable changes to `ratel-ai-rankers-plugin` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-rc.1] - 2026-10-16

### Added

- First release (ADR-0028). The vendor rankers move here from `ratel-ai`:
  - `ratel_jev_plugin(url=None, api_key_env=None, model=None)` returns a `RetrieverPlugin` for Jev (TypeSafe AI; key in `TYPESAFE_API_KEY`). It moved from `ratel-ai` 0.13.0rc11.
  - `ratel_openai_decision_plugin(url=None, api_key_env=None, model=None)` returns one for OpenAI's Decisions API (public beta; key in `OPENAI_API_KEY`, model `gpt-6-luna`). A model refusal is the transient `RetrieverError` code `"Refused"`. The first plugin made emits a one-time `ExperimentalWarning`; `RATEL_EXPERIMENTAL_SILENCE=1` silences it.
  - Both send the query and each candidate's searchable text to the vendor.
- `choice_ranker_plugin(ranker)`, the shared adapter, turns any object with a `rank(query, [(id, text)], top_k, kind)` method into a plugin.
- Re-exports the SDK's plugin contract (`RankFn`, `RankCandidate`, `RankedId`, `RetrieverError`, `RetrieverPlugin`, `define_plugin`). Requires `ratel-ai>=0.13.0rc12,<1.0`.
