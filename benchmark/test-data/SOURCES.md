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

## `synthetic.jsonl`

Hand-authored smoke fixture under this repo's license. Used by tests and by quick local smoke runs without external downloads.
