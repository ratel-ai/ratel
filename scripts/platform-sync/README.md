# `scripts/platform-sync/`

The repeatable copy of the open-source parts of `ratel-cloud` into `apps/web`
([ADR-0030](../../docs/adr/0030-platform-oss-layered-core-and-cloud-sync.md)). Runs until
`ratel-cloud` is retired; after that the tool and this folder go.

## Layout

| File | What it is |
|---|---|
| `map.json` | What moves where. `copy`: mirrored on every sync with imports rewritten. `owned`: bootstrapped once, then maintained here. `excluded`: never lands. |
| `rewrites.json` | Explicit import-specifier rules (`@/components/ds/*` to `@ratel/design-system/*`, `@/lib/utils` to the design-system `cn`). Moves inside `apps/web/lib` are derived from `map.json`. |
| `private-strings.txt` | Regexes for Cloud-only code (scoped to `apps/web`) and salted hashes of confidential words (whole tree; the word is never written down). A landed file or upstream path matching one fails or skips the sync; `pnpm check:private` scans the repository with the same list. |
| `source.json` | The `ratel-cloud` commit last synced. |
| `sync.mjs` | The driver: plan, format (one biome run over a staged mirror of the plan), private-string guard, write, record. |
| `rewrite-imports.mjs` | The codemod (pure). |
| `private-strings.mjs` | The guard (pure) and its CLI, `pnpm check:private`. |
| `undecided.mjs` | The upstream files with no decision in `map.json`, at the synced commit. A local tool: it needs the `ratel-cloud` repository. |

## Run

```sh
pnpm platform:sync                                  # from ../ratel-cloud, everything in map.json
pnpm platform:sync -- --only apps/web/lib/ingest    # one destination prefix
pnpm platform:sync -- --check                       # write nothing; exit 1 if a sync would change the tree
RATEL_CLOUD_DIR=~/Developer/Ratel/ratel-cloud pnpm platform:sync  # another source (or --source); fails if it is not a ratel-cloud checkout
pnpm platform:undecided                             # upstream files with no decision; exit 1 if there is one
```

A sync lands as its own pull request, `chore(platform): sync ratel-cloud <sha>`, with the
printed report in the body. The mechanical part is trusted because the codemod is tested and CI
is the bar; the reviewer reads the **owned drift** section, which lists the upstream changes to
files this repository maintains, and ports what applies by hand.

## Rules

The working rule for anyone landing Cloud code (map first, sync, resolve every unmapped
specifier, minimal owned edits) is the "Code from ratel-cloud" section of
[`AGENTS.md`](../../AGENTS.md). The specifics:

- Never edit a `copy` file here: the next sync overwrites it. Fix it upstream, or change its mode
  to `owned` in `map.json` with a reason.
- The `biome.json` override for copied code is `copyIncludes(map)` from `sync.mjs`; `sync.test.mjs`
  fails when the two differ, so regenerate it after changing a `copy` entry.
- A new `@/lib/*` specifier the rules do not map is reported as *unmapped*; add the move to
  `map.json` (or a rule to `rewrites.json`) before landing.
- The product's name in a copied string becomes `APP_NAME` (the `brand` rule in `rewrites.json`); a
  test gets the default name. A string that spans lines is left alone: own the file.
- A private-string hit is never worked around in the list; the file is excluded or fixed upstream.
- Every upstream file under `apps/web` and `packages` has a decision. Most are an entry in
  `map.json`. A file whose upstream path contains a confidential word has none on purpose: writing
  the path would publish the word. The sync never lands such a path, even under a mapped folder
  (it reports "skipped N upstream path(s) naming confidential data" when an entry reaches one); at
  the synced commit there are three, a customer replay seed (a module and its test under
  `apps/web/lib/seed/`, its loader under `apps/web/scripts/`). `pnpm platform:undecided` lists the
  upstream files with no decision and counts those three as decided. It reads the synced commit from the `ratel-cloud` repository's
  history, whatever is checked out there, so it is a local tool, not a CI check.
