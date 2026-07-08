# Changelog

All notable changes to `ratel-ai-cloud` (the Python cloud catalog-source loader) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The cloud catalog-source loader (ADR-0003) over the frozen protocol/v1 contract:
  `create_skill_sync()` (offline-tolerant handle) and `sync_skills()` (one-shot),
  `SkillSync` with the ownership rule (synced ids only; host skills reported in
  `conflicts`, never touched), conditional-GET `fetch_catalog()` with a per-`(url, scope)`
  ETag cache, and the typed error taxonomy (`ConfigError` / `AuthError` / `ApiError` /
  `UnavailableError`) mapped from the frozen error body.
- Canonicalization + ETag reference (`ratel_ai_cloud.canonical`) pinned to every
  `protocol/v1/conformance/vectors.json` vector.
- `ratel_ai_cloud.testing.MockSource`: an in-process HTTP catalog source (real ETag
  algorithm, weak `If-None-Match`, scope overlay, Bearer auth, failure injection) for
  loader tests.
