# Architecture decision records

The decisions that shape this repository today. Each record states the current decision. Git
history holds the earlier records and how they changed.

| # | Decision |
|---|---|
| [0001](0001-record-architecture-decisions.md) | Keep a small, current set of ADRs |
| [0002](0002-products-and-repositories.md) | Products and repositories |
| [0003](0003-two-editions-one-application.md) | Two editions, one application: Cloud modules in a private checkout at `ee/src` |
| [0004](0004-layered-core-and-module-ownership.md) | A layered core, and modules that own their schema |
| [0005](0005-background-worker.md) | Background work runs in a worker process, chosen by `APP_ROLE` |
| [0006](0006-licensing.md) | Licensing: MIT, no copyleft |
| [0007](0007-sdk-wire-contracts.md) | The platform serves the SDK's wire contracts |
| [0008](0008-single-ci-gate.md) | One required `ci-gate` check |
| [0009](0009-model-vendors.md) | Model calls go through one kit, and a deployment names its vendors |

The SDK decisions (engine, retrieval, bindings, adapters, rankers, releases) belong to
[ratel-ai/ratel-sdk](https://github.com/ratel-ai/ratel-sdk), where that code lives.
