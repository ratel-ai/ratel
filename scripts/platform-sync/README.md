# `scripts/platform-sync/`

The repeatable copy of the open-source parts of `ratel-cloud` into `apps/web`
([ADR-0030](../../docs/adr/0030-platform-oss-layered-core-and-cloud-sync.md)). Runs until
`ratel-cloud` is retired; after that the tool and this folder go.

## Layout

| File | What it is |
|---|---|
| `map.json` | What moves where. `copy`: mirrored on every sync with imports rewritten. `owned`: bootstrapped once, then maintained here. `excluded`: never lands. |
| `rewrites.json` | Explicit import-specifier rules (`@/components/ds/*` to `@ratel/design-system/*`, `@/lib/utils` to the design-system `cn`). Moves inside `apps/web/lib` are derived from `map.json`. |
| `private-strings.txt` | One regex per line. A landed file matching any of them fails the sync; CI greps `apps/web` and the OSS image with the same list. |
| `source.json` | The `ratel-cloud` commit last synced. |
| `sync.mjs` | The driver: plan, private-string guard, write, format, record. |
| `rewrite-imports.mjs` | The codemod (pure). |
| `private-strings.mjs` | The guard (pure) and its CLI, `pnpm check:private`. |

## Run

```sh
pnpm platform:sync                                  # from ../ratel-cloud, everything in map.json
pnpm platform:sync -- --only apps/web/lib/ingest    # one destination prefix
pnpm platform:sync -- --check                       # write nothing; exit 1 if a sync would change the tree
```

A sync lands as its own pull request, `chore(platform): sync ratel-cloud <sha>`, with the
printed report in the body. The mechanical part is trusted because the codemod is tested and CI
is the bar; the reviewer reads the **owned drift** section, which lists the upstream changes to
files this repository maintains, and ports what applies by hand.

## Rules

- Never edit a `copy` file here: the next sync overwrites it. Fix it upstream, or change its mode
  to `owned` in `map.json` with a reason.
- A new `@/lib/*` specifier the rules do not map is reported as *unmapped*; add the move to
  `map.json` (or a rule to `rewrites.json`) before landing.
- A private-string hit is never worked around in the list; the file is excluded or fixed upstream.
