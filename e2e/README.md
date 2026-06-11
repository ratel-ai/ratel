# End-to-end product checks (`e2e/`)

These runners exercise the **real, installed distributables** (the wheel, the npm
tarball + native binary, the CLI package) through each SDK's **public API** — not the
dev-mode source build. They are driven by the `pr-gate` workflow
(`.github/workflows/pr-gate.yml`) after artifacts are built, and can be run locally.

## What it covers

A single, language-neutral fixture + scenario is exercised identically by every SDK,
so a behavior divergence between SDKs (they all wrap the same Rust BM25 core) makes
exactly one runner fail:

- `fixtures/catalog.json` — the shared tool catalog (the input).
- `scenario.json` — the assertions (the source of truth): per-query top-1 ranking,
  direct invoke, and the gateway `search_tools` / `invoke_tool` surfaces.

| Runner | Package under test | Surface exercised |
|--------|--------------------|-------------------|
| `python/run_e2e.py` | `ratel-ai` wheel | `ToolCatalog` search/invoke + `search_tools_tool` / `invoke_tool_tool` |
| `ts/run_e2e.mjs` | `@ratel-ai/sdk` (+ native binary) | `ToolCatalog` search/invoke + `searchToolsTool` / `invokeToolTool` |
| `cli/run_e2e.sh` | `@ratel-ai/cli` | binary loads + `mcp add/list/get/remove` round-trip (sandboxed `HOME`) |

The CLI runner deliberately avoids spawning live MCP servers (passing `--description`
skips the upstream probe); the deep search/invoke parity is proven through the two SDKs.

## Run locally

**Python** — build & install the wheel into a throwaway venv, then run:
```bash
cd src/sdk/python
python -m venv /tmp/ratel-e2e-py && /tmp/ratel-e2e-py/bin/pip install -U pip maturin
/tmp/ratel-e2e-py/bin/maturin build --release --out /tmp/ratel-wheels
/tmp/ratel-e2e-py/bin/pip install /tmp/ratel-wheels/*.whl
/tmp/ratel-e2e-py/bin/python ../../../e2e/python/run_e2e.py
```

**TS** — pack the SDK, install the tarball into a temp dir, then run:
```bash
pnpm --filter @ratel-ai/sdk build
TGZ="$(cd src/sdk/ts && pnpm pack --pack-destination /tmp/ratel-tgz | tail -1)"
mkdir -p /tmp/ratel-e2e-ts && cd /tmp/ratel-e2e-ts && npm init -y >/dev/null
npm install "$TGZ"
node <repo>/e2e/ts/run_e2e.mjs
```

**CLI** — pack & install the CLI, point `RATEL_BIN` at the installed bin:
```bash
TGZ="$(pnpm --filter @ratel-ai/cli pack --pack-destination /tmp/ratel-cli | tail -1)"
mkdir -p /tmp/ratel-e2e-cli && cd /tmp/ratel-e2e-cli && npm init -y >/dev/null
npm install "$TGZ"
RATEL_BIN="$PWD/node_modules/.bin/ratel" bash <repo>/e2e/cli/run_e2e.sh
```

## Extending

When you add product surface (new tools, a new SDK method, a new CLI command):

1. Add the tool(s) to `fixtures/catalog.json`.
2. Add a query with an unambiguous expected top-1 to `scenario.json` (write the tool's
   description so the query's terms clearly match it; assertions check top-1, not full
   ordering, to stay robust to score ties).
3. If you exercise a new method/command, extend the relevant runner(s) — and keep the
   Python and TS runners in lockstep so parity stays enforced.
