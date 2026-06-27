# `src/sdk/python/examples/`

Runnable demos that drive the [`ratel-ai`](../README.md) SDK end-to-end. Each is a standalone script, run from this directory; nothing here ships in the published wheel.

## `observability_demo.py`

Exercises the lean observability layer entirely through the public SDK — no database access, no SQL. It does two things:

- **Live skill / tool suggestions** — for a few sample chat messages, ranks a skill corpus (`SkillCatalog`) and a tool catalog (`ToolCatalog`) with Ratel's BM25 engine and prints the context Ratel would surface, plus the tokens a selected top-K keeps out of the prompt.
- **An SDK-driven adoption story** — backfills N days of interactions where Ratel starts **off** (the full tool catalog in every prompt, only "could-have-saved" recorded via `saveable_by_category`) and switches **on** partway through (prompts shrink, real savings recorded via `saved_by_category`). Each interaction is shipped as one usage rollup with `get_client().track(...)`, so the dashboard fills with real, SDK-sourced data.

It sends real usage rollups to `POST {RATEL_HOST}/api/v1/events`, best-effort in a background thread, and `flush()`es before exit.

## Env vars

```bash
export RATEL_API_KEY=rtl_...                  # the project's ingest key from the dashboard
export RATEL_HOST=https://cloud.ratel.sh      # optional; this is the default
```

Without `RATEL_API_KEY` the demo runs in no-op mode: suggestions still print, but nothing is sent (the SDK never raises on a missing key).

## Run

```bash
# print skill/tool suggestions only — sends nothing, no key needed
python observability_demo.py --suggest-only

# seed a 21-day adoption story, 12 interactions/day, Ratel on for the last ~45%
python observability_demo.py --days 21 --runs 12 --adopt 0.55
```

Flags: `--days`, `--runs` (interactions per day), `--adopt` (fraction of the window before Ratel turns on), `--seed` (PRNG seed for reproducibility), `--suggest-only` (print suggestions, send nothing).
