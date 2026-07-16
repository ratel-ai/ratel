# `@ratel-ai/local-skills`

The reference [`CatalogLoader`](../ts/README.md) for Ratel: hydrate a `SkillCatalog` from a
directory of `<name>/SKILL.md` files — the Ratel-managed skills folder of
[ADR-0005](../../../docs/adr/0005-first-class-skills.md) (default `~/.ratel/skills`). It is the
first loader package to sit on the SDK's loader seam
([ADR-0003](../../../docs/adr/0003-catalog-source-interface.md)); the SDK stays
dependency-lean while this package owns the filesystem scan and its YAML dependency.

## Usage

```ts
import { attachLoader, SkillCatalog } from "@ratel-ai/sdk";
import { LocalSkillsLoader } from "@ratel-ai/local-skills";

const catalog = new SkillCatalog();
const handle = await attachLoader(catalog, new LocalSkillsLoader()); // ~/.ratel/skills
// ... search_capabilities / get_skill_content over the loaded skills ...
await handle.refresh(); // re-scan: pick up edits, new files, and deletions
await handle.detach();  // stop; the last-synced skills stay in the catalog
```

Pass `new LocalSkillsLoader({ dir })` to load a different folder. The loader can also be driven
directly (`start(catalog)` / `refresh()` / `stop()`) without `attachLoader`.

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

- Package name: `@ratel-ai/local-skills`
- Pure TypeScript (no native binding); runtime dependency [`yaml`](https://www.npmjs.com/package/yaml);
  `@ratel-ai/sdk` is a peer
- MIT ([ADR-0009](../../../docs/adr/0009-licensing.md)); member of the pnpm workspace

## Build & test

From the repo root:

```bash
pnpm --filter @ratel-ai/local-skills build
pnpm --filter @ratel-ai/local-skills typecheck
pnpm --filter @ratel-ai/local-skills lint
pnpm --filter @ratel-ai/local-skills test
```

The tests build the catalog from a temp directory and exercise the full contract: frontmatter
parsing and field defaults, body extraction, the diagnostics for malformed/duplicate files, the
add/update/remove/skip-unchanged refresh paths, and the `attachLoader` integration.
