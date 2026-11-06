# `lib/mcp` (L7)

The MCP server behind `POST /api/mcp`: stateless Streamable HTTP, one JSON-RPC message (or a
small batch) per POST, every operation exposed as its own tool plus `whoami`. It may import any
lower layer and nothing imports it. Export names follow upstream so copied call sites stay
identical.

| Path | Holds |
|---|---|
| `auth.ts` | who is calling: a project API key (`rtl_…`) resolved to its project and organization; the OAuth arm is declared for the tool contract and refused here (owned) |
| `route-handler.ts`, `transport.ts`, `server.ts` | the POST handler (credential and per-key rate limits, body and batch caps, the JSON-RPC envelope), the single-message transport, and the `McpServer` that registers every operation as a tool |
| `dispatch.ts` | one pipeline for every call: scope resolution (a key's project, or an explicit `projectId`), params validation, the outcome event; internal failures never reach the client |
| `registry.ts`, `operations/index.ts` | `defineOperation`, the domains, and `assembleOperations` (writes can be left out) |
| `errors.ts`, `serialize.ts`, `windows.ts`, `client-address.ts`, `public-origin.ts` | the error codes and bodies, row caps and truncation, time windows, the caller's address, the origin a client reached |
| `naming.ts` | the routing and family keywords and the internal product names a tool id must not use (owned; `operations/naming.test.ts` enforces it) |
| `operations/scope.ts` | `list_projects`, `get_project_overview`, `describeCaller` for `whoami` |
| `operations/catalog.ts`, `writes.ts`, `writes-runtime.ts` | skills and tools as declared and as observed; the skill writes, imports and runtime overrides |
| `operations/observability.ts`, `calibration.ts` | traces, spans, cost by day and by tool, ingest diagnostics; experiments and their mismatches |
| `operations/improvement.ts`, `joins.ts`, `tool-explorer.ts`, `tool-crafter.ts` | match quality runs and proposals, the improvement signals, tool co-usage and transitions, the drafted fixes and `generate_tool_crafts` |
| `operations/account.ts` | `get_flag_status`, `get_quota_status` (the entitlements port), `get_job_status` (owned) |
| `operations/playground.ts` | `test_retrieval`: rank a query against the catalog with draft edits, metered per credential |
| `operations/loop/` | the improvement loop as tools, behind `FF_MCP_LOOP` (`loop-flag.ts`): `list_insights`, `list_fixes`, `get_fix`, `get_eval`, `run_eval` (also behind `FF_EVAL_GATE`), `create_experiment`, `mark_fix_shipped`; each result names its source one step back, and the writes record lineage |
| `stages.ts` | which loop stage (Monitor, Insights, Improve, Ship) each tool belongs to, published as `_meta["sh.ratel/stage"]` while the loop is on |
| `operations/params.ts`, `mutation-errors.ts` | the shared `projectId` and end-user params; mutation failures as operation errors |
| `connect/snippets.ts` | the Integrations page's copy-paste client configuration (Claude Code, Claude Desktop, Cursor / VS Code, CI), the worked example and the capability groups; `page-contract.test.ts` keeps the page's tool names real (owned snippets, see below) |

## Owned files

The rest mirror upstream (`scripts/platform-sync/map.json`).

- `auth.ts`: project keys only. The `oauth` arm of `McpAuthContext` stays declared (the identity
  provider's id is `externalUserId`) so every project-scoped tool keeps its explicit `projectId`
  and the copied dispatch, route handler and tests compile unchanged; the default verifier
  refuses any bearer that is not a key, with no provider call. The organization on the context is
  `McpOrganization` (id, slug, the plan from the entitlements port) in place of upstream's flag
  identity.
- `naming.ts`: one entry of `INTERNAL_PRODUCT_NAMES` is a confidential word and is left out, and
  no routing keyword points at `get_embedding_usage`.
- `operations/account.ts`: no `get_embedding_usage`; the Embedding API and its credit ledger stay
  private. `operations/contract.test.ts` and `compatibility.test.ts` pin the surface without it.
- `operations/playground.ts`: `test_retrieval` embeds through the embedding-provider port
  (`composition.embeddingProvider`), as the Playground route does, instead of a vendor key.
- `route-handler.test.ts`: the verifier-crash fixture names no vendor.
- `loop-flag.ts` (with its test): one env switch, `FF_MCP_LOOP`, in place of upstream's per-key and
  per-organization flag. `operations/loop/index.ts` and `loop.test.ts`: seven tools; the task tools
  (`list_tasks`, `get_task`) and task simulations land with the task loop. `list_fixes` and
  `get_fix` return a fix's newest draft (`lib/views/fix-drafts`) while `FF_EVAL_GATE` is on, null
  otherwise, and a ready draft supplies `get_fix`'s change. `run-eval-gate.integration.test.ts`: the gate is the env
  switch. `stages.ts`: no stage for the tools this build does not have. `operations/index.ts`,
  `route-handler.ts` and `server.ts` wire the loop as upstream does.
  `__fixtures__/tools-list-before-loop.json` is this build's tool list before the loop:
  `route-handler.test.ts` checks that with the loop off it is listed exactly as before, and with it on
  an existing tool changes only by its stage `_meta`.
- `connect/snippets.ts` and `snippets.test.ts`: every client carries the project key (Claude
  Code through `--header`, Cursor and VS Code through `${env:RATEL_API_KEY}` in `mcp.json`,
  Claude Desktop through the `mcp-remote` bridge in its config, CI as upstream), because there is
  no browser sign-in to offer the interactive clients.

Not here, with a `$why` in the map: `oauth-metadata.ts` and the `.well-known/oauth-*` routes
(OAuth discovery needs the private identity provider). The copied 401 still advertises the
protected-resource metadata URL in `WWW-Authenticate`; nothing serves it in this edition.
