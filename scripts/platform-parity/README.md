# Platform parity harness (temporary)

Tools that hold the open-source edition (`apps/web`) to what Ratel Cloud does, while the 28
inconsistencies of the platform split audit are being fixed. The reference is Ratel Cloud at the
commit in `scripts/platform-sync/source.json`. Everything here, and `apps/web/parity/`, is removed
when the last fix has landed (RTL-45).

## The three parts

| Part | Where | Runs |
|---|---|---|
| Capture | `capture.sh`, `capture.mts`, `cloud-subjects.mts` | Locally, by hand, with a Cloud checkout |
| Compare | `apps/web/parity/*.parity.test.ts` | In the platform test suite, locally and in CI |
| Side by side | `side-by-side.sh`, `side-by-side/`, `expected-differences.json` | Locally, by hand, with Docker and a Cloud checkout |

### Capture

```sh
RATEL_CLOUD_DIR=/path/to/ratel-cloud pnpm --filter @ratel/platform parity:capture
```

Feeds the inputs in `apps/web/parity/inputs.ts` to Cloud's own code and writes what it answers to
`apps/web/parity/golden/`, one JSON file per subject. It runs from the Cloud checkout's `apps/web`,
so `@/…` resolves to Cloud's code. It refuses to run unless the checkout is at the commit in
`source.json`, and it refuses to write a file that trips the private-strings guard, because the
files are committed here. CI never runs it: it has no Cloud checkout.

### Compare

The parity tests feed the same inputs to this repository's code and compare with the captured
files. See `apps/web/parity/README.md`.

### Side by side

```sh
RATEL_CLOUD_DIR=/path/to/ratel-cloud scripts/platform-parity/side-by-side.sh
scripts/platform-parity/side-by-side.sh --compare-only   # compare what the last run collected
```

Runs both editions on one throwaway Postgres, seeded with the same history, and compares schema
facts, what the seed stored, the readings row by row, four MCP calls and the visible text of
twelve pages, with the feature flags off and on. It needs Docker, the installed Chrome, Node 24
(fetched when the shell's is older) and the Cloud checkout with its dependencies installed. It
takes about ten minutes.

`expected-differences.json` lists the differences that are meant to be there (`natural`), each
with the natural difference it stands for. A difference that is not listed is printed and the
script exits 1. The `audit` entries only put the audit's item number beside a printed line; a
fix removes its entries when it lands. A printed line with no item number is a difference the
audit did not find.

Five things to know:

- **No model key is in reach.** The database is its own compose project, the root `.env` is not
  loaded, and every host command runs in an emptied environment.
- **The collected output stays outside the repository** (`PARITY_WORK`, default
  `/private/tmp/ratel-parity`). It contains Cloud's output, which `pnpm check:private` would
  refuse, and that check also walks git-ignored folders.
- **Cloud is set up to be comparable.** Its local organization is put on the enterprise plan,
  whose limits are this edition's. Its flags are switched off and on by their environment names
  (`FF_CLOUD_…`), because they default to on in local development. Its first visit provisions a
  demo project of its own, so everything is read for the Site Copilot project only.
- **Both editions get the match-quality seed** after the first drain, so Fixes lists the
  description rewrites too (16 fixes on the sample project).
