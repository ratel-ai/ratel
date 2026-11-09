# Parity tests (temporary)

Tests that pass only when this repository answers as Ratel Cloud does, for the 28 items of the
platform split audit. Cloud's answers are the captured files under `golden/`, taken from Ratel
Cloud at the commit in `scripts/platform-sync/source.json`. This folder and
`scripts/platform-parity/` are removed when the last fix has landed (RTL-45).

## How a test is built

1. `inputs.ts` holds the inputs, as plain data. The capture feeds them to Cloud's code; a test
   feeds the same values to this repository's code.
2. `golden/<subject>.json` is what Cloud answered. Never edit one by hand: rerun the capture
   (`scripts/platform-parity/README.md`).
3. `normalise.ts` is the only place where a difference is treated as equal. Each rule names the
   natural difference it stands for. A test calls its functions on both sides and compares; it
   never filters or renames by itself. A new rule is a claim that a difference is natural, which
   is not a fix's call to make.
4. `source-probes.ts` reads a fact off a source file for the items about what a page renders or
   what a boot hook calls. The same function runs on Cloud's file at capture and on this
   repository's file in the test. What the page shows is compared by `side-by-side.sh`.

## The ledger

`ledger.json` lists the audit's 28 items, each `open` or `fixed`.

- `parity(<item>, …)` in a test file ties a test to an item. While the item is `open`, the test
  runs and is reported as todo: it does not fail the run.
- A fix pull request flips its items to `fixed`. From then on their tests gate CI.
- `control(…)` is behaviour that already matches Cloud. It gates CI from the start.
- `ledger.parity.test.ts` fails when the ledger does not have exactly 28 items, when an item has
  no test, or when a captured file is missing or from another Cloud commit.

## Commands

```sh
# From apps/web. The parity tests also run with the rest of the suite (`pnpm test`).
npx -y node@24 --import tsx --test "parity/**/*.test.ts"

# Every test as a gate, to see what an open item still fails on.
PARITY_STRICT=1 npx -y node@24 --import tsx --test "parity/**/*.test.ts"
```

A failing comparison prints the places that differ, as `path: here …, Cloud …`.

## When a fix changes a signature

A test calls this repository's functions as they are today. If a fix changes how a function is
called (for example ⌘K's entries taking the scope instead of the rail), update the call in the
test. The captured files, the inputs and `normalise.ts` stay as they are.
