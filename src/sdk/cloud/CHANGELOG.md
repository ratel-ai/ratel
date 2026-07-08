# Changelog

All notable changes to `@ratel-ai/cloud` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial package: the pull-sync loader for a networked catalog source over the frozen protocol/v1 contract. `createSkillSync()` attaches a source to a `SkillCatalog` and returns a handle (periodic `setTimeout` refresh chain with jitter, offline-tolerant first fetch, `lastSyncedAt` / `consecutiveFailures` staleness signals); `syncSkills()` is the one-shot variant. Synced skills are owned by the loader — host-registered skills are never touched and surface in `SyncResult.conflicts`. Conditional GET with the frozen ETag algorithm, per-`(url, scope)` cache, typed error taxonomy, and a vector-pinned in-process mock source under `@ratel-ai/cloud/testing`.
