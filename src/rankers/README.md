# `src/rankers/`

Vendor rankers for the SDKs' ranking hooks, kept out of core and the SDKs ([ADR 0028](../../docs/adr/0028-vendor-rankers-as-plugin-packages.md)). The SDKs rank through functions they are given (`retrieveFn` / `rerankerFn`, [ADR 0027](../../docs/adr/0027-custom-retriever-and-reranker-functions.md)) and know no vendor's API. The clients for decision models (Jev, OpenAI Decisions) live here and ship as plugin packages. Adding a vendor takes no core or SDK release.

## Layout

```
core/     ratel-ai-rankers: the shared tournament/HTTP/error logic plus one backend per vendor (internal crate, not published)
ts/       @ratel-ai/rankers-plugin (npm): napi binding of core/ plus the TS plugins; peers on @ratel-ai/sdk
python/   ratel-ai-rankers-plugin (PyPI): pyo3 binding of core/ plus the Python plugins; depends on ratel-ai
```

The plugin contract (`RankFn`, `RetrieverError`, `RetrieverPlugin`, `definePlugin`) is owned by the SDKs, because catalogs check `RetrieverError` by class. So each plugin package depends on its SDK, never the other way round, and re-exports the contract so a plugin author imports everything from one place.

`ts/` ships on `rankers-ts-v*` and `python/` on `rankers-py-v*`, each as an independent release unit ([ADR 0008](../../docs/adr/0008-release-engineering.md)). Release the SDK they peer on first. `core/` is built into both and is in both units' release paths.
