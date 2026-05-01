# Corpus provenance

Attribution and reproduction details for every committed corpus file under this directory. Per ADR-0006, raw downloads live under `benchmark/fixtures/` (gitignored); the files here are normalized JSONL snapshots produced by `cargo run -p ratel-benchmark -- ingest <source>`.

## `metatool.jsonl`

- **Upstream**: [HowieHwong/MetaTool](https://github.com/HowieHwong/MetaTool)
- **License**: MIT (Copyright © 2023 Yue Huang)
- **Upstream commit**: `35e81bb7576826e980c80fed8f8c0a2b4a1e6fbb` (master at time of ingest)
- **Source files used**: `dataset/plugin_des.json`, `dataset/data/all_clean_data.csv`, `dataset/data/multi_tool_query_golden.json`
- **Ingest command** (one-shot — pulls upstream via `curl` into the gitignored fixtures dir, then samples):
  ```bash
  cargo run -p ratel-benchmark --release -- ingest metatool \
    --download --sample 1000 --multi-tool-ratio 0.03 --seed 42
  ```
- **Resulting shape**: 1000 scenarios — ≈970 single-tool + ≈30 multi-tool — over 199 OpenAI plugin descriptions.

## `toolret.jsonl`

- **Upstream**: [mangopy/ToolRet-Tools](https://huggingface.co/datasets/mangopy/ToolRet-Tools) (44,453 tools across `code` / `customized` / `web` subsets) + [mangopy/ToolRet-Queries](https://huggingface.co/datasets/mangopy/ToolRet-Queries) (7,961 queries across 35 sub-corpora)
- **License**: Apache-2.0
- **Source files used**: every Parquet file under both datasets' auto-converted `parquet/` namespace (38 files total).
- **Ingest command** (one-shot — pulls upstream parquet via `curl` into the gitignored fixtures dir, then writes the full corpus):
  ```bash
  cargo run -p ratel-benchmark --release -- ingest toolret --download
  ```
- **Resulting shape**: 7,956 scenarios (7,961 upstream queries minus 5 with gold tools missing from the published catalog). No sampling — the snapshot covers the full upstream query set; rows are stable-sorted by id. Universe of unique gold tool ids ≈ 7,651, drawn from the 44,453-tool catalog.
- **Mapping notes**: `prompt` is the upstream `instruction` with the `Given a … task, retrieve tools that …` wrapper stripped (uniform-noise reduction, identity fallback). `gold_tools` collects every label with `relevance == 1` (or implicit positive when the field is absent, as in the apibank sub-corpus). `candidate_pool` carries only the gold tool(s) per row — the runner pools distractors across all scenarios at retrieval time, mirroring the MetaTool convention.

## `synthetic.jsonl`

Hand-authored smoke fixture under this repo's license. Used by tests and by quick local smoke runs without external downloads.
