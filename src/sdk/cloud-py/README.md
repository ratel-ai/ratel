# `ratel-ai-cloud` (Python)

Cloud catalog-source loader for the Python SDK: pull-syncs a project's published skills
from a networked catalog source into a local `ratel_ai.SkillCatalog` over the frozen
[protocol/v1 contract](../../../protocol/v1/README.md) (conditional GET + ETag, Bearer
auth, opaque `?scope=`). Retrieval stays local — the source only answers a conditional
GET ([ADR-0003](../../../docs/adr/0003-catalog-source-interface.md)). HTTP is stdlib
`urllib`; the package is pure Python with no HTTP client dependency.

## Usage

```python
from ratel_ai import SkillCatalog
from ratel_ai_cloud import create_skill_sync

catalog = SkillCatalog()
# Reads RATEL_URL / RATEL_API_KEY unless url= / api_key= are passed explicitly.
sync = create_skill_sync(catalog, interval_s=300)
# ... catalog now serves synced skills to the capability tools ...
sync.stop()
```

- `create_skill_sync(catalog, **options)` — offline-tolerant: hydrates now if the source
  is reachable, keeps the last-pulled replica on transient failures, and (with
  `interval_s`) keeps refreshing on a jittered timer. Staleness surfaces on the handle
  as `last_synced_at` / `consecutive_failures`.
- `sync_skills(catalog, **options)` — one-shot refresh that raises on any failure.
- Explicit options beat the environment; no URL anywhere raises `ConfigError`
  (`RATEL_URL` unset is the permanent embedded floor — no loader, app code unchanged).

The loader owns only the skills it synced: host-registered skills are never touched, and
an id collision is reported in `SyncResult.conflicts` instead of being overwritten.

## Layout

- `ratel_ai_cloud/canonical.py` — frozen v1 canonicalization, ETag, scope-overlay resolver.
- `ratel_ai_cloud/errors.py` — typed errors mapped from the frozen error body.
- `ratel_ai_cloud/fetch_catalog.py` — conditional GET of `/v1/catalog` via stdlib `urllib`.
- `ratel_ai_cloud/skill_sync.py` — `SkillSync`: refresh/ownership/timer semantics.
- `ratel_ai_cloud/testing/` — `MockSource`, an in-process conformant catalog source.
- `tests/` — TDD suite, pinned to `protocol/v1/conformance/vectors.json`.

## Package shape

- Distribution name: `ratel-ai-cloud`; import name: `ratel_ai_cloud`
- Pure Python (hatchling build, universal wheel); depends only on `ratel-ai`
- MIT ([ADR-0009](../../../docs/adr/0009-licensing.md))

## Build & test

From this directory, reusing the Python SDK's venv (which has `ratel_ai` installed via
`maturin develop` — see [`../python/README.md`](../python/README.md) for its setup):

```bash
uv pip install --python ../python/.venv -e .
../python/.venv/bin/ruff check .
../python/.venv/bin/mypy ratel_ai_cloud
../python/.venv/bin/pytest
```
