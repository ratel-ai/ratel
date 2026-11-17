# `lib/mcp` (L7)

The MCP server behind `POST /api/mcp`: stateless Streamable HTTP, one JSON-RPC message (or a
small batch) per POST, every operation exposed as its own tool plus `whoami`. It may import any
lower layer and nothing imports it. Export names follow upstream so copied call sites stay
identical.

| Path | Holds |
|---|---|
| `auth.ts` | who is calling: a project API key (`rtl_…`) resolved to its project and organization, or, in an edition that supplies the `mcpOAuth` port, a person who signed in through a browser, with their organizations; without the port any other bearer is refused (owned). `auth-edition.test.ts` pins that seam |
| `route-handler.ts`, `transport.ts`, `server.ts` | the POST handler (credential and per-key rate limits, body and batch caps, the JSON-RPC envelope), the single-message transport, and the `McpServer` that registers every operation as a tool |
| `dispatch.ts` | one pipeline for every call: scope resolution (a key's project, or an explicit `projectId`), params validation, the outcome event; internal failures never reach the client |
| `registry.ts`, `operations/index.ts` | `defineOperation`, the domains, and `assembleOperations` (writes can be left out) |
| `errors.ts`, `serialize.ts`, `windows.ts`, `client-address.ts`, `public-origin.ts` | the error codes and bodies, row caps and truncation, time windows, the caller's address, the origin a client reached |
| `naming.ts` | the routing and family keywords and the internal product names a tool id must not use (owned; `operations/naming.test.ts` enforces it) |
| `operations/scope.ts` | `list_projects`, `get_project_overview`, `describeCaller` for `whoami` |
| `operations/catalog.ts`, `writes.ts`, `writes-runtime.ts` | skills and tools as declared and as observed; the skill writes, imports and runtime overrides |
| `operations/observability.ts`, `calibration.ts` | traces, spans, cost by day and by tool, ingest diagnostics; experiments and their mismatches |
| `operations/improvement.ts`, `joins.ts`, `tool-explorer.ts`, `tool-crafter.ts` | match quality runs and proposals, the improvement signals, tool co-usage and transitions, the drafted fixes and `generate_tool_crafts` |
| `operations/account.ts` | `get_flag_status` (the deployment's `FF_*` switches), `get_quota_status` (the entitlements port; the sample project is free), `get_job_status` (owned) |
| `operations/runs.ts`, `health.ts`, `intents.ts`, `quality.ts`, `ranking.ts`, `experiments.ts`, `developer.ts`, `ship.ts` | the console's other pages as tools (upstream RC-234): runs, spans, logs, turns, sessions and trace comparisons; Agent health, issue examples and self-corrections; intents; Quality and its description rewrites; the adaptive-ranking graphs; experiments and selections; SDK events, API keys and setup; shipments and lineage |
| `operations/content-access.ts` | which tools may show captured content, and the marker for what is withheld |
| `launch-access.ts` | the app's allowlist at the MCP door: a project key passes, a signed-in caller is decided by the edition (owned) |
| `operations/playground.ts` | `test_retrieval`: rank a query against the catalog with draft edits, metered per credential |
| `operations/loop/` | the improvement loop as tools, listed for everyone with app access as upstream (RC-234), with its tasks (`tasks.ts`: task pages, scorers, eval sets, simulations, drafted tests) and fix eval sets (`eval-sets.ts`): `list_tasks`, `get_task` (a task's scorers, score series and eval set, empty with `FF_EVAL_GATE` off), `list_insights`, `list_fixes`, `get_fix`, `get_eval`, `run_eval` (also behind `FF_EVAL_GATE`; a fix with tasks is simulated once per task, `operations/loop/task-simulation.ts` reads the runs), `create_experiment`, `mark_fix_shipped`; each result names its source one step back, and the writes record lineage |
| `stages.ts` | which loop stage (Monitor, Insights, Improve, Ship) each tool belongs to, published as `_meta["sh.ratel/stage"]` |
| `operations/params.ts`, `mutation-errors.ts` | the shared `projectId` and end-user params; mutation failures as operation errors |
| `connect/snippets.ts` | the Integrations page's copy-paste client configuration (Claude Code, Claude Desktop, Cursor / VS Code, CI), the worked example and the capability groups; `page-contract.test.ts` keeps the page's tool names real (owned snippets, see below) |

## Owned files

The rest mirror upstream (`scripts/platform-sync/map.json`).

- `auth.ts`: upstream verifies an OAuth token with its identity provider here. This file hands a
  bearer that is not a key to `composition.mcpOAuth` (`lib/contracts/mcp-oauth.ts`) and builds
  the `oauth` arm of `McpAuthContext` from the answer (the provider's id is `externalUserId`),
  with upstream's two refusals: an invalid token, and an identity with no account yet. The
  open-source edition has no such port, so the default verifier refuses any bearer that is not a
  key, with no provider call. The arm stays declared either way, so every project-scoped tool
  keeps its explicit `projectId` and the copied dispatch, route handler and tests compile
  unchanged. The organization on the context is `McpOrganization` (id, slug, the plan from the
  entitlements port) in place of upstream's flag identity.
- `naming.ts`: one entry of `INTERNAL_PRODUCT_NAMES` is a confidential word and is left out, and
  no routing keyword points at `get_embedding_usage`.
- `operations/account.ts`: no `get_embedding_usage`; the Embedding API and its credit ledger stay
  private. `operations/contract.test.ts` and `compatibility.test.ts` pin the surface without it.
- `operations/playground.ts`: `test_retrieval` embeds through the embedding-provider port
  (`composition.embeddingProvider`), as the Playground route does, instead of a vendor key.
- `route-handler.test.ts`: the verifier-crash fixture names no vendor.
- `operations/loop/index.ts` and `loop.test.ts`: the eval gate is the env switch; `mark_fix_shipped` loads the task loop's shipment record (`views/task-evals/ship.ts`),
  so with `FF_EVAL_GATE` on it queues the post-ship measures. `list_fixes` and
  `get_fix` return a fix's newest draft (`lib/views/fix-drafts`) while `FF_EVAL_GATE` is on, null
  otherwise, and a ready draft supplies `get_fix`'s change. `run-eval-gate.integration.test.ts`: the gate is the env
  switch. `stages.ts`: no stage for the tools this build does not have (embedding and Tool Picker
  usage). `route-handler.ts` and `server.ts`: the server name and the bearer realm say `ratel`, and
  signed-in callers pass `launch-access.ts`. `__fixtures__/tools-list.json` is this build's tool
  list, regenerated with `UPDATE_MCP_TOOLS_FIXTURE=1`; `route-handler.test.ts` pins it.
- `launch-access.ts` (with its test): upstream asks its identity provider and flag service whether
  a signed-in caller may use the app; here a project key passes and a signed-in caller is the
  edition's decision, refused until one is wired.
- `operations/developer.ts` (with its test): no `get_tool_picker_usage`; the Tool Picker and its
  ledger stay private. `operations/health.ts`: imports come from the edition
  (`EditionUi.HealthImports`). `operations/loop/read.ts`: an unknown organization reads the
  entitlements port's default limits. `operations/ranking.ts`: the Boost reads come from
  `views/adaptive-ranking/queries.ts`. Upstream's `account.test.ts` (its flag service, wallets and
  embedding usage) is not here.
- `connect/snippets.ts` and `snippets.test.ts`: every client carries the project key (Claude
  Code through `--header`, Cursor and VS Code through `${env:RATEL_API_KEY}` in `mcp.json`,
  Claude Desktop through the `mcp-remote` bridge in its config, CI as upstream), because there is
  no browser sign-in to offer the interactive clients.

Not here, with a `$why` in the map: `oauth-metadata.ts` and the `.well-known/oauth-*` routes
(OAuth discovery needs the private identity provider). The copied 401 still advertises the
protected-resource metadata URL in `WWW-Authenticate`; the Cloud edition serves it from its own
routes, and nothing serves it in the open-source edition.
