# `ratel-ai-local-skills` (Python)

The reference `CatalogLoader` for Ratel: hydrate a `SkillCatalog` from a directory of
`<name>/SKILL.md` files — the Ratel-managed skills folder of
[ADR-0005](https://github.com/ratel-ai/ratel/blob/main/docs/adr/0005-first-class-skills.md)
(default `~/.ratel/skills`). It is the first loader package on the SDK's loader seam
([ADR-0003](https://github.com/ratel-ai/ratel/blob/main/docs/adr/0003-catalog-source-interface.md));
the SDK stays dependency-lean while this package owns the filesystem scan and its YAML dependency.
The Python mirror of [`@ratel-ai/local-skills`](https://github.com/ratel-ai/ratel/tree/main/src/sdk/local-skills).

## Usage

```python
import asyncio

from ratel_ai import SkillCatalog, attach_loader
from ratel_ai_local_skills import LocalSkillsLoader


async def main() -> None:
    catalog = SkillCatalog()
    handle = await attach_loader(catalog, LocalSkillsLoader())  # ~/.ratel/skills
    # ... search_capabilities / get_skill_content over the loaded skills ...
    await handle.refresh()  # re-scan: pick up edits, new files, and deletions
    await handle.detach()   # stop; the last-synced skills stay in the catalog


asyncio.run(main())
```

Pass `LocalSkillsLoader(dir)` to load a different folder. The loader can also be driven directly
without `attach_loader`: `await start(catalog)` and `await refresh()` mirror the directory (async
because they await the catalog's embedding pass), and `stop()` is synchronous.

## Layout contract

- Only immediate `<dir>/<name>/SKILL.md` files load (non-recursive, sorted scan); a
  subdirectory without a `SKILL.md` is ignored.
- Each file is YAML frontmatter fenced by `---` at byte 0, then a Markdown body. Fields:
  `id` (defaults to the directory name), `name` (defaults to `id`), `description` (required —
  the main ranking signal), and optional `tags` / `tools` (string lists) and `metadata`
  (a map of string lists). The body is the dispatch payload returned by `get_skill_content`.
- A malformed file (no fence, bad YAML, missing `description`, wrong-typed field) is skipped
  and recorded on `loader.diagnostics`, which is replaced each scan — its siblings still load.
  A duplicate `id` keeps the first sorted directory and diagnoses the rest.
- `refresh()` upserts new or changed files (raw-text equality is the change fingerprint, so an
  untouched file is not re-embedded) and removes vanished ids — but only ids this loader
  loaded, never skills another writer put in the catalog.

## Package shape

- Distribution name: `ratel-ai-local-skills`; import name: `ratel_ai_local_skills`
- Pure Python (hatchling build, no Rust extension); depends on `ratel-ai` (the SDK) and
  [`pyyaml`](https://pypi.org/project/PyYAML/)
- MIT ([ADR-0009](https://github.com/ratel-ai/ratel/blob/main/docs/adr/0009-licensing.md))

## Build & test

From this directory (needs [uv](https://docs.astral.sh/uv/)):

```bash
uv venv --python 3.11 .venv
# ratel-ai is a native (maturin) build; install it from the local source so the
# CatalogLoader seam this loader targets is present. Then install this package with
# --no-deps and its tools, so the local ratel-ai build is never replaced by the
# same-versioned published wheel (which predates the seam).
uv pip install --python .venv ../python
uv pip install --python .venv --no-deps -e .
uv pip install --python .venv pyyaml types-PyYAML pytest pytest-asyncio ruff mypy
.venv/bin/ruff check . && .venv/bin/mypy ratel_ai_local_skills && .venv/bin/pytest
```

The tests build the catalog from a temp directory and exercise the full contract: frontmatter
parsing and field defaults, body extraction, the diagnostics for malformed/duplicate files, the
add/update/remove/skip-unchanged refresh paths, and the `attach_loader` integration.
