# Changelog

## [0.6.0](https://github.com/ratel-ai/ratel/compare/v0.5.0...v0.6.0) (2026-11-27)


### Features

* **web:** Dashboards, Explore, Scorers and Alerts as top-level items ([#476](https://github.com/ratel-ai/ratel/issues/476)) ([29a8c70](https://github.com/ratel-ai/ratel/commit/29a8c70c9b31baa050ef45929d5c634646679662))
* **web:** Dashboards, Explore, Scorers, Alerts as top-level Monitor items ([29a8c70](https://github.com/ratel-ai/ratel/commit/29a8c70c9b31baa050ef45929d5c634646679662))
* **web:** designed empty states for the Overview widgets ([#477](https://github.com/ratel-ai/ratel/issues/477)) ([87a3f39](https://github.com/ratel-ai/ratel/commit/87a3f39ed473a590d274382eafcbe04f46ccd4bd))
* **web:** MCP item in the project rail opens the MCP setup guide ([#480](https://github.com/ratel-ai/ratel/issues/480)) ([602fa89](https://github.com/ratel-ai/ratel/commit/602fa89b561e099bd9922cf27f5c356c7940c01e))
* **web:** one scorer model, task kinds as preset scorers ([#481](https://github.com/ratel-ai/ratel/issues/481)) ([7fe53e5](https://github.com/ratel-ai/ratel/commit/7fe53e57f4b0d63f7eb2c5adf512b334d21ea3a7))
* **web:** RQL core with MCP tools describe_rql_schema and run_rql ([#482](https://github.com/ratel-ai/ratel/issues/482)) ([a936aee](https://github.com/ratel-ai/ratel/commit/a936aee5768e457d4982e89a86bc23a641b0a867))
* **web:** RQL in Explore, dashboards and alerts ([#483](https://github.com/ratel-ai/ratel/issues/483)) ([7567bb4](https://github.com/ratel-ai/ratel/commit/7567bb4010d58eabfcff6c07e161cdc403a69597))


### Bug Fixes

* **health:** check each problem's evidence before showing it ([#486](https://github.com/ratel-ai/ratel/issues/486)) ([08eeb6c](https://github.com/ratel-ai/ratel/commit/08eeb6c609b3c1f0c40b732521446e9318dd47d7))
* persist ingested events and metrics atomically ([#443](https://github.com/ratel-ai/ratel/issues/443)) ([e859ae6](https://github.com/ratel-ai/ratel/commit/e859ae64103b300d0c5f2a6ddfeca4e1badf80b0))
* prevent late workers from overwriting reaped jobs ([#413](https://github.com/ratel-ai/ratel/issues/413)) ([1c1dcbc](https://github.com/ratel-ai/ratel/commit/1c1dcbce9d0919246533bbcab387c3632dc5e6fc))
* **web:** held card follows the pointer in the arrange grid ([f4f0799](https://github.com/ratel-ai/ratel/commit/f4f0799a3ab3702190992b7892a1a0096eb75870))
* **web:** held widget follows the pointer while dragged ([#475](https://github.com/ratel-ai/ratel/issues/475)) ([f4f0799](https://github.com/ratel-ai/ratel/commit/f4f0799a3ab3702190992b7892a1a0096eb75870))
* **web:** monitoring review follow-ups (RTL-293) ([#479](https://github.com/ratel-ai/ratel/issues/479)) ([0a46b71](https://github.com/ratel-ai/ratel/commit/0a46b71bf0b2b4dc9080f172c95d5cdddfa0840a))

## [0.5.0](https://github.com/ratel-ai/ratel/compare/v0.4.0...v0.5.0) (2026-11-25)


### Features

* **ingest:** queue accepted batches, persist them from a fair per-project queue ([#469](https://github.com/ratel-ai/ratel/issues/469)) ([b0f1cd5](https://github.com/ratel-ai/ratel/commit/b0f1cd5ea9723a956d2e8ada2025159562a17886))
* **web:** custom scorers and dashboards behind customMonitoring ([#445](https://github.com/ratel-ai/ratel/issues/445)) ([e640c78](https://github.com/ratel-ai/ratel/commit/e640c78f961d8ab097d90380873af147cb97196c))
* **web:** MCP operations and MCP App views for custom monitoring ([#452](https://github.com/ratel-ai/ratel/issues/452)) ([0637b44](https://github.com/ratel-ai/ratel/commit/0637b44d29c48cde881753b66c12d4901ca2c672))
* **web:** metric alerts behind customMonitoring ([#446](https://github.com/ratel-ai/ratel/issues/446)) ([8c707d1](https://github.com/ratel-ai/ratel/commit/8c707d1f96c948a281e578ae61faa0dc5fee4bd4))
* **web:** Slack delivery for metric alerts ([#447](https://github.com/ratel-ai/ratel/issues/447)) ([c507564](https://github.com/ratel-ai/ratel/commit/c507564ee9bd1c00953f515bfa59ca5d3cc4fe5c))

## [0.4.0](https://github.com/ratel-ai/ratel/compare/v0.3.1...v0.4.0) (2026-11-25)


### Features

* **overview:** draw one widget or the whole page in MCP Apps ([#455](https://github.com/ratel-ai/ratel/issues/455)) ([1d320b9](https://github.com/ratel-ai/ratel/commit/1d320b9e9e80824844afe3bc03fd7063235a8924))
* **overview:** keep a history of layout changes with Undo and Restore ([#456](https://github.com/ratel-ai/ratel/issues/456)) ([1cc3dec](https://github.com/ratel-ai/ratel/commit/1cc3decc94266b5bd19ee24b94da195473905e2b))
* **web:** a quiet Overview of widgets, with an edit mode ([#450](https://github.com/ratel-ai/ratel/issues/450)) ([e67982c](https://github.com/ratel-ai/ratel/commit/e67982c26bc2fed06129719b1a5d22541a93746c))
* **web:** focus Agent health, Self-corrections and Overview behind focusedConsole ([#433](https://github.com/ratel-ai/ratel/issues/433)) ([c553674](https://github.com/ratel-ai/ratel/commit/c553674541c3442008bc1e66765e417a6c1b2ec6))

## [0.3.1](https://github.com/ratel-ai/ratel/compare/v0.3.0...v0.3.1) (2026-11-23)


### Bug Fixes

* **release:** build X.Y.Z images with a valid Next deployment id ([#430](https://github.com/ratel-ai/ratel/issues/430)) ([45f934b](https://github.com/ratel-ai/ratel/commit/45f934b37c0ea7f773a2004062de43a8aa14f03e))
* **release:** valid Next deployment id for X.Y.Z images, drop release-as ([45f934b](https://github.com/ratel-ai/ratel/commit/45f934b37c0ea7f773a2004062de43a8aa14f03e))

## 0.3.0 (2026-11-23)


### Features

* **deploy:** run the published image on every deploy path ([#428](https://github.com/ratel-ai/ratel/issues/428)) ([3da62da](https://github.com/ratel-ai/ratel/commit/3da62da9f851e183ae59fed5cf6eca10b577bfd6))
