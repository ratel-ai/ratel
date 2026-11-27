# `lib/mcp` (L7)

The MCP server behind `POST /api/mcp`: stateless Streamable HTTP, one JSON-RPC message (or a
small batch) per POST, every operation exposed as its own tool plus `whoami`. It may import any
lower layer and nothing imports it. Export names follow upstream so copied call sites stay
identical.

| Path | Holds |
|---|---|
| `auth.ts` | who is calling: a project API key (`rtl_…`) resolved to its project, organization and scopes (a key with no MCP scope is refused with 403; `dispatch.ts` asks `mcp:read` or `mcp:write` per tool), or, in an edition that supplies the `mcpOAuth` port, a person who signed in through a browser, with their organizations; without the port any other bearer is refused (owned). `auth-edition.test.ts` pins that seam |
| `route-handler.ts`, `transport.ts`, `server.ts` | the POST handler (credential and per-key rate limits, body and batch caps, the JSON-RPC envelope), the single-message transport, and the `McpServer` that registers every operation as a tool |
| `dispatch.ts` | one pipeline for every call: scope resolution (a key's project, or an explicit `projectId`), params validation, the outcome event; internal failures never reach the client |
| `registry.ts`, `operations/index.ts` | `defineOperation`, the domains, and `assembleOperations` (writes can be left out) |
| `operations/edition.ts` | the tools an edition adds through `Registration.mcpOperations` (`lib/contracts/registry.ts`): each validated (a free snake_case id, a 21 to 400 character description, no own `projectId`, no keyword a core tool owns in `naming.ts`, an `after` naming a core tool), published read-only in the `account` domain with the core's `projectId`, and listed after its anchor. A bad one throws, and `instrumentation.node.ts` assembles the list at boot, so it stops startup. `edition.test.ts` pins placement, schema, stage, dispatch and each refusal (owned) |
| `errors.ts`, `serialize.ts`, `windows.ts`, `public-origin.ts` | the error codes and bodies, row caps and truncation, time windows, the origin a client reached (the caller's address is `platform/http/client-address.ts`, which ingest limits share) |
| `naming.ts` | the routing and family keywords and the internal product names a tool id must not use (owned; `operations/naming.test.ts` enforces it) |
| `operations/scope.ts` | `list_projects`, `get_project_overview`, `describeCaller` for `whoami` |
| `operations/catalog.ts`, `writes.ts`, `writes-runtime.ts` | skills and tools as declared and as observed; the skill writes, imports and runtime overrides |
| `operations/observability.ts`, `calibration.ts` | traces, spans, cost by day and by tool, ingest diagnostics; experiments and their mismatches |
| `operations/improvement.ts`, `joins.ts`, `tool-explorer.ts`, `tool-crafter.ts` | match quality runs and proposals, the improvement signals, tool co-usage and transitions, the drafted fixes and `generate_tool_crafts` |
| `operations/account.ts` | `get_flag_status` (the deployment's core flags, by key: `evalGate`, `rankingCatalogDrift`, `mcpApps`, `agentsPages`, `toolRunInsights` and `focusedConsole`), `get_quota_status` (the entitlements port: limits with `"unlimited"` for no cap, the match quality run budget, and a `plan` block when the edition has plans; the demo project is free; its hint names `get_embedding_usage` only when the edition lists it), `get_job_status` (owned) |
| `operations/runs.ts`, `health.ts`, `intents.ts`, `quality.ts`, `ranking.ts`, `experiments.ts`, `developer.ts`, `ship.ts` | the console's other pages as tools (upstream RC-234): runs, spans, logs, turns, sessions and trace comparisons; Agent health, issue examples and self-corrections; intents; Quality and its description rewrites; the adaptive-ranking graphs; experiments and selections; SDK events, API keys and setup; shipments and lineage |
| `operations/content-access.ts` | which tools may show captured content, and the marker for what is withheld |
| `telemetry/` | each tool call as an `execute_tool` span with its arguments and result (`trace-tool-call.ts`, owned for one comment; `session.ts`: the client, credential and session ids), sent only to a Ratel project of its own (`export.ts`, owned: off unless `RATEL_SELF_TELEMETRY_MCP_API_KEY` and `RATEL_SELF_TELEMETRY_ENDPOINT` are both set, no default destination; ratel-cloud #482) |
| `launch-access.ts` | the app's allowlist at the MCP door: a project key passes, a signed-in caller is decided by the edition (owned) |
| `operations/playground.ts` | `test_retrieval`: rank a query against the catalog with draft edits, metered per credential |
| `operations/sandboxes.ts` | `sandbox_list`, `sandbox_get_version`, `sandbox_run`, `sandbox_get_run`: find a pushed agent version, read how to call it, run it with one input and read the result. Listed only with the `evals` flag (one flag for the sandbox and the evals); each tool also asks the `sandboxes:*` key scope of its REST route |
| `operations/evals.ts` | `evals_*`: save a sandbox run as a case, approve it, start an eval run, read it and its trials, compare two runs and pin the baseline. Listed only with the `evals` flag; each tool also asks the `evals:*` key scope. Captured text follows `content-access.ts` |
| `operations/loop/` | the improvement loop as tools, listed for everyone with app access as upstream (RC-234), with its tasks (`tasks.ts`: task pages, scorers, eval sets, simulations, drafted tests) and fix eval sets (`eval-sets.ts`): `list_tasks`, `get_task` (a task's scorers, score series and eval set, empty with `evalGate` off), `list_insights`, `list_fixes`, `get_fix`, `get_eval`, `run_eval` (also behind `evalGate`; a fix with tasks is simulated once per task, `operations/loop/task-simulation.ts` reads the runs), `create_experiment`, `mark_fix_shipped`; each result names its source one step back, and the writes record lineage |
| `apps/` | MCP Apps (SEP-1865): the `ui://ratel/<view>` resources built by the `@ratel/mcp-apps` package (repository root `mcp-apps/`) and the tools bound to them, behind `mcpApps` (`apps/flag.ts`, owned); with the switch off the server is what it was, pinned by `route-handler.apps.test.ts` and `__fixtures__/flag-off-protocol.json` (owned). See `apps/README.md` |
| `stages.ts` | which loop stage (Monitor, Insights, Improve, Ship) each tool belongs to, published as `_meta["sh.ratel/stage"]`; `toolStage` also reads an edition tool's own stage |
| `operations/params.ts`, `mutation-errors.ts` | the shared `projectId` and end-user params; mutation failures as operation errors |
| `connect/snippets.ts` | the Integrations page's copy-paste client configuration (Claude Code, Claude Desktop, Cursor / VS Code, CI), the worked example and the capability groups; `page-contract.test.ts` keeps the page's tool names real, `connect-ui.test.ts` the connect panel with and without browser sign-in (owned snippets, see below) |

## Owned files

These differ from their `ratel-cloud` origin ("upstream").

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
  no routing keyword points at `get_embedding_usage`, which only an edition lists.
- `operations/account.ts`: no `get_embedding_usage`; the Embedding API and its credit ledger are
  the edition's, which adds the tool through `operations/edition.ts` (Cloud: `ee/src/src/apis/mcp`),
  and `get_quota_status` gives upstream's hint pointing at it only then.
  `operations/contract.test.ts` and `compatibility.test.ts` pin the core's surface, without it.
- `operations/index.ts`: also places the edition's tools (`operations/edition.ts`).
- `operations/agents.ts` and `operations/mcp-servers.ts`: the default gate is the core's
  `agentsPages` (`views/project-entities/flag.ts`), not upstream's flag service; off, the four
  tools refuse as forbidden. `operations/entities-gate.test.ts` (no upstream counterpart) pins it.
- `operations/overview.ts` (no upstream counterpart): `get_overview` and `change_overview_layout`, the
  recap Overview and its layout through the web's own loader and action. `focusedConsole` off for the
  caller, they are not listed and the overview view is not published; off for the project's
  organization, they refuse. `get_overview` with `widget` reads and draws one widget alone, with only its own reads, also when the person removed it; a new
  widget needs an entry in `WIDGET_DATA` and no operation. `list_overview_changes`,
  `undo_overview_change` and `restore_overview_layout` are the web's History, Undo and Restore; the
  last two need the revision that the agent read, and answer `conflict` (`stale`) on another one. All
  draw the overview view. An API key reads the default layout, cannot change one and has no history.
- `apps/flag.ts`, `apps/apps.test.ts`, `apps/README.md`, `route-handler.apps.test.ts` and
  `__fixtures__/flag-off-protocol.json`: MCP Apps are one switch for the deployment,
  `mcpApps`; upstream asks its flag service per project key or person, with timeouts and a
  cache, so its cases for a hung or slow lookup have no counterpart. The fixture is captured from
  this server with the switch off.
- `operations/playground.ts`: `test_retrieval` embeds through the embedding-provider port
  (`composition.embeddingProvider`), as the Playground route does, instead of a vendor key.
- `route-handler.test.ts`: the verifier-crash fixture names no vendor.
- `operations/loop/index.ts` and `loop.test.ts`: the eval gate is the configured `evalGate` switch; `mark_fix_shipped` loads the task loop's shipment record (`views/task-evals/ship.ts`),
  so with `evalGate` on it queues the post-ship measures. `list_fixes` and
  `get_fix` return a fix's newest draft (`lib/views/fix-drafts`) while `evalGate` is on, null
  otherwise, and a ready draft supplies `get_fix`'s change. `run-eval-gate.integration.test.ts`: the gate is the env
  switch. `stages.ts`: no map entry for the tools an edition adds (embedding and Tool Picker
  usage); each carries its own stage, which `toolStage` reads. `route-handler.ts` and `server.ts`:
  the server name, its instructions and the bearer realm take the edition's `productName`
  (`ratel` and "Ratel" without one), signed-in callers pass `launch-access.ts`,
  and the stage comes from `toolStage`. `__fixtures__/tools-list.json` is this build's tool
  list, regenerated with `UPDATE_MCP_TOOLS_FIXTURE=1`; `route-handler.test.ts` pins it.
- `launch-access.ts` (with its test): upstream asks its identity provider and flag service whether
  a signed-in caller may use the app; here a project key passes and a signed-in caller is the
  edition's decision, refused until one is wired.
- `operations/developer.ts` (with its test): no `get_tool_picker_usage`; the Tool Picker and its
  ledger are the edition's, which adds the tool after `list_api_keys`, where upstream lists it. `operations/health.ts`: imports come from the edition
  (`EditionUi.HealthImports`). `operations/loop/read.ts`: an unknown organization reads the
  entitlements port's default limits. `operations/ranking.ts`: the Boost reads come from
  `views/adaptive-ranking/queries.ts`. `operations/account.test.ts` keeps upstream's quota cases
  with a stand-in plan table on the entitlements port; its flag service, wallet and embedding
  usage cases are not here.
- `connect/snippets.ts` and `snippets.test.ts`: with `browserSignIn` (the edition supplies
  `mcpOAuth`) the snippets and their tests are upstream's: Claude Code, Claude Desktop and Cursor
  sign in through a browser and only CI carries a key. Without it every client carries the
  project key (Claude Code through `--header`, Cursor and VS Code through `${env:RATEL_API_KEY}`
  in `mcp.json`, Claude Desktop through the `mcp-remote` bridge in its config, CI as upstream),
  because there is no browser sign-in to offer the interactive clients.

Not here, with a `$why` in the map: `oauth-metadata.ts` and the `.well-known/oauth-*` routes
(OAuth discovery needs the private identity provider). The copied 401 still advertises the
protected-resource metadata URL in `WWW-Authenticate`; the Cloud edition serves it from its own
routes, and nothing serves it in the open-source edition.
