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
| [0009](0009-queued-ingest.md) | Ingest accepts a batch fast and a fair queue persists it |
| [0010](0010-kafka-ingest.md) | A worker stores the telemetry that a gateway put on Kafka, with `INGEST_QUEUE=kafka` |
| [0011](0011-rql-query-language.md) | RQL (Ratel Query Language): a neutral read-only query language, behind two walls (0010 is kept for the model vendors record of PR #442) |
| [0012](0012-trace-properties-storage.md) | Trace properties: key names per project, values in one jsonb column with one shared GIN index |
| [0013](0013-clusters-property-filter.md) | Clusters: filter and split the stored analysis by a trace property through the turn link (Proposed) |

The SDK decisions (engine, retrieval, bindings, adapters, rankers, releases) belong to
[ratel-ai/ratel-sdk](https://github.com/ratel-ai/ratel-sdk), where that code lives.
