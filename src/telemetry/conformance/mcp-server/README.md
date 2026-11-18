# conformance/mcp-server

The contract fixtures for MCP server spans: real OTLP/JSON trace exports of the MCP SDKs'
native OpenTelemetry instrumentation (TS SDK v2 on Streamable HTTP, Python SDK on stdio).
Ratel Cloud ingest reads its client facts from spans of this shape.

The files are copied byte-identical from ratel-cloud
`apps/web/lib/otlp/__fixtures__/client-facts/`. Its `README.md` is here as `UPSTREAM-README.md`
(how the bodies were made, and what each file holds). Do not edit them: copy them again and update
the hashes below, so drift is visible.

| file | sha256 |
| --- | --- |
| `UPSTREAM-README.md` (upstream `README.md`) | `3a99201d5cc4a8376967eb6db17b6990713d22ea32d757d1162af2022f151d5a` |
| `py-stdio-codex-initialize.otlp.json` | `150ef25fd520fc14dfc2caeb8831280a1be8534b363b9f84ca5da564f7505039` |
| `py-stdio-codex-tools-call.otlp.json` | `3b2849bc98e52111c08a9e1e9448e51c8c2c0f92aac2e4aa4d591cb35d8d597a` |
| `ts-http-claude-code-initialize.otlp.json` | `4599f56438f41ae094dc65e22d83d4347ce20c92b45ca0ee84c072fb00b9bbc0` |
| `ts-http-claude-code-tools-call.otlp.json` | `0d253539f51bc23b79dd36681cf7ad57f857468cf0e41d6800e6c2c9638d8734` |
| `ts-http-cursor-initialize.otlp.json` | `c57698707159f8c22a380fd2c32e161bbe8d2ff88eccabbd5412bd9a9b7481fe` |
| `ts-http-cursor-tools-call.otlp.json` | `ed5e44c443788c927e16c06a43fbebeaee79c6ed06313fe0149a898fcb495318` |

Check: `shasum -a 256 *` in this folder.

## Consumer

`../../../sdk/ts/src/mcp-server.test.ts` runs `instrumentMcpServer` against a real MCP client
(`ts-http-*` over Streamable HTTP, `py-stdio-*` over stdio). For each MCP server span in a file
(kind SERVER with `mcp.method.name`), it requires a span with the same name, kind SERVER, every
attribute key of the fixture span, and `mcp.client.name` / `mcp.client.version` (plus
`mcp.server.name` / `.version` on `initialize`). Values may differ.

`../../../sdk/python/tests/test_mcp_server.py` runs the same check for `instrument_mcp_server`
(Python), over Streamable HTTP and a real stdio child process.
