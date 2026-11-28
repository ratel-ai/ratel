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
| `operations/edition.ts` | the tools an edition adds through `Registration.mcpOperations` (`lib/contracts/registry.ts`): each validated (a free snake_case id, a 21 to 400 character description, no own `projectId`, no keyword a core tool owns in `naming.ts`, an `after` naming a core tool), published read-only in the `account` domain with the core's `projectId`, and listed after its anchor. A bad one throws, and `instrumentation-node.ts` assembles the list at boot, so it stops startup. `edition.test.ts` pins placement, schema, stage, dispatch and each refusal (owned) |
| `errors.ts`, `serialize.ts`, `windows.ts`, `public-origin.ts` | the error codes and bodies, row caps and truncation, time windows, the origin a client reached (the caller's address is `platform/http/client-address.ts`, which ingest limits share) |
| `naming.ts` | the routing and family keywords and the internal product names a tool id must not use (owned; `operations/naming.test.ts` enforces it) |
| `operations/scope.ts` | `list_projects`, `get_project_overview`, `describeCaller` for `whoami` |
| `operations/catalog.ts`, `writes.ts`, `writes-runtime.ts` | skills and tools as declared and as observed; the skill writes, imports and runtime overrides |
| `operations/observability.ts`, `calibration.ts` | traces, spans, cost by day and by tool, ingest diagnostics; experiments and their mismatches |
| `operations/improvement.ts`, `joins.ts`, `tool-explorer.ts`, `tool-crafter.ts` | match quality runs and proposals, the improvement signals, tool co-usage and transitions, the drafted fixes and `generate_tool_crafts` |
| `operations/account.ts` | `get_flag_status` (the deployment's core flags, by key: `evalGate`, `rankingCatalogDrift`, `mcpApps`, `agentsPages`, `toolRunInsights`, `focusedConsole` and `customMonitoring`), `get_quota_status` (the entitlements port: limits with `"unlimited"` for no cap, the match quality run budget, and a `plan` block when the edition has plans; the demo project is free; its hint names `get_embedding_usage` only when the edition lists it), `get_job_status` (owned) |
| `operations/runs.ts`, `health.ts`, `intents.ts`, `quality.ts`, `ranking.ts`, `experiments.ts`, `developer.ts`, `ship.ts` | the console's other pages as tools (upstream RC-234): runs, spans, logs, turns, sessions and trace comparisons; Agent health, issue examples and self-corrections; intents; Quality and its description rewrites; the adaptive-ranking graphs; experiments and selections; SDK events, API keys and setup; shipments and lineage |
| `operations/content-access.ts` | which tools may show captured content, and the marker for what is withheld |
| `telemetry/` | each tool call as an `execute_tool` span with its arguments and result (`trace-tool-call.ts`, owned for one comment; `session.ts`: the client, credential and session ids), sent only to a Ratel project of its own (`export.ts`, owned: off unless `RATEL_SELF_TELEMETRY_MCP_API_KEY` and `RATEL_SELF_TELEMETRY_ENDPOINT` are both set, no default destination; ratel-cloud #482) |
| `launch-access.ts` | the app's allowlist at the MCP door: a project key passes, a signed-in caller is decided by the edition (owned) |
| `operations/playground.ts` | `test_retrieval`: rank a query against the catalog with draft edits, metered per credential |
| `operations/loop/` | the improvement loop as tools, listed for everyone with app access as upstream (RC-234), with its tasks (`tasks.ts`: task pages, scorers, eval sets, simulations, drafted tests) and fix eval sets (`eval-sets.ts`): `list_tasks`, `get_task` (a task's scorers, score series and eval set, empty with `evalGate` off), `list_insights`, `list_fixes`, `get_fix`, `get_eval`, `run_eval` (also behind `evalGate`; a fix with tasks is simulated once per task, `operations/loop/task-simulation.ts` reads the runs), `create_experiment`, `mark_fix_shipped`; each result names its source one step back, and the writes record lineage |
| `operations/monitoring/` | custom monitoring as tools (owned; behind `customMonitoring`, off refuses as forbidden): `scorers.ts` (`list_scorers`, `get_scorer`, `test_scorer`, `change_scorer`), `alerts.ts` (`list_alerts`, `get_alert`, `change_alert`, `list_alert_destinations`, `change_alert_destination`, `list_slack_channels`), `locations.ts` (`get_location_attributes`, `change_location_attributes`), `properties.ts` (`list_trace_properties`, `change_trace_property`: the trace properties, RTL-395; a plan refusal is `quota_exceeded` with its reason), `dashboards.ts` (`describe_monitoring_schema`, `query_monitoring`, `list_dashboards`, `get_dashboard`, `change_dashboard`, `import_dashboard`; `results.ts` caps a result and says it in one line), `rql.ts` (`describe_rql_schema`, `run_rql`; listed only with `customMonitoring` on, see below), `ask.ts` (`draft_widgets`: RQL widgets drafted from words, `views/ask`; it saves no widget, stores the ask, and counts against the limits of Ask in words; listed only with `customMonitoring` on). Each calls the same action as the console's server action (`deps.ts`: the caller in the session's place, and the refusals as MCP errors). No result holds a secret, and a param an operation names in `secretParams` is left out of the call's telemetry. `parity.ts` maps each console action of these modules to its operation, and `parity.test.ts` fails for one without |
| `apps/` | MCP Apps (SEP-1865): the `ui://ratel/<view>` resources built by the `@ratel/mcp-apps` package (repository root `mcp-apps/`) and the tools bound to them, behind `mcpApps` (`apps/flag.ts`, owned); with the switch off the server is what it was, pinned by `route-handler.apps.test.ts` and `__fixtures__/flag-off-protocol.json` (owned). See `apps/README.md` |
| `stages.ts` | which loop stage (Monitor, Insights, Improve, Ship) each tool belongs to, published as `_meta["sh.ratel/stage"]`; `toolStage` also reads an edition tool's own stage |
| `operations/params.ts`, `mutation-errors.ts` | the shared `projectId` and end-user params; mutation failures as operation errors |
| `connect/snippets.ts` | the MCP connection guide's (Integrations, and a project's MCP page) copy-paste client configuration (Claude Code, Claude Desktop, Cursor / VS Code, CI), the worked example and the capability groups; `page-contract.test.ts` keeps the page's tool names real, `connect-ui.test.ts` the connect panel with and without browser sign-in (owned snippets, see below) |

## Explore through MCP

Explore (`views/explore`) stores nothing, so an agent has it with three operations that take the same
query object. `query_monitoring` runs one query, or two to four panels with `queries`, under one
window and one set of filters; its `href` is the Explore page with the same panels, filters and
exact window, and a host with views draws the panels side by side. The filter of a query is a list of
clauses that must all match: its own properties, then each one of `and`. All clauses with the filters
of the dashboard or the call are 3,072 bytes of JSON at most. With `as: "sql"` it gives
the RQL text of a lone metric query instead of its numbers: the query of kind `sql` with its `form`
that a metric widget keeps (`views/dashboards/metric-rql.ts`). Every metric has one. A widget given
as kind `metric` (change_dashboard, import_dashboard) is kept as kind `sql` with its form, and
get_dashboard gives it so; its summary says its numbers as the metric does. A flow, step flow,
funnel or geography query with `groupBy` (RTL-398) gives kind `grouped`: each value with its traces,
its numbers in one line and its result, and `leftOut`; get_dashboard lists the values of a grouped
widget (`groups`, `leftOutValues`).
`change_dashboard` (`create`, `add_widget`) saves a panel, and `change_alert` (`create`) watches an
ungrouped metric. `EXPLORE` in `operations/monitoring/parity.ts` is that list, and the parity test
fails for an action of the page that is not in it.

## RQL through MCP

RQL (Ratel Query Language, `synthesis/rql`) answers a trace question that no query kind has. Two tools in
`operations/monitoring/rql.ts` give it to an agent, behind the `customMonitoring` flag:

- `describe_rql_schema` gives `describeRqlSchema(properties)`: the tables (`events`, `traces`, `scores`,
  `sessions`, `users`, `prompts`), their columns, the functions, the operators, the limits, the rules,
  examples, and the trace properties of the caller's project only (`properties.indexed`, which
  `properties['name']` reads, and apart `properties.detected`).
- `run_rql` takes `text`, an optional `rqlVersion` (default: the current one) and `since`/`until`
  (default: the last 24 hours; a window over 30 days is refused). It runs kind `sql` of the query
  object through `runQuery` with `purpose: "agent"`, the same path as `query_monitoring` (whose
  kind `sql` reads up to 372 days, as the console), and gives `summary`, `columns`, `rows` and
  `truncated`. The `table` view of `mcp-apps/` draws it.

`query_monitoring` runs a lone query of kind `sql` too and gives its table; a panel of `queries`
cannot be one. `query_monitoring`, `change_dashboard` and `change_alert` take a trace property in a
filter (`filters.properties`, `filters.withoutProperties`, on every kind with a trace filter, and in
the filters of a dashboard and of `query_monitoring`, RTL-397) and in a metric's group-by (`{ "property": "<name>" }`). A property
that is not indexed is refused with the reason `property_not_indexed`, its name and the fix, by
`run_rql` and by `query_monitoring`. `describe_monitoring_schema` lists kind `sql` in its catalog.

With `customMonitoring` off for the connection (`customMonitoringForCaller`: an API key's project,
or any organization of a person) the two tools are not listed and the `table` view is not
published. Each call checks the flag of its project again (`requireMonitoring`): off, the two tools
and `query_monitoring` refuse with `forbidden` and the reason `custom_monitoring_off`. An RQL error reaches the agent as the compiler or the runner
wrote it: its code as `reason`, its message, and its `fix` (`deps.ts`, `queryRefusal`). The console
has no RQL page yet, so `MCP_ONLY` in `parity.ts` lists the two tools with that reason.

## Adding an operation

The parity rule is in the repository's `AGENTS.md`. Declare the operation with `defineOperation` and
list it in `operations/index.ts`, `stages.ts` and `operations/contract.test.ts`. Map the console
action it stands for in `operations/monitoring/parity.ts`. Regenerate the tool list with
`UPDATE_MCP_TOOLS_FIXTURE=1` on `route-handler.test.ts`. Bind it to a view in `mcp-apps/views/`.

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
  organization, they refuse. `get_overview` with `widget` reads and draws one widget alone, with only its own reads, also when the person removed it.
  A dashboard widget is named by `dashboardId` and `widgetId` in place of `widget`, in both operations:
  `dashboardWidgets` has the numbers as `query_monitoring` gives them, or why there are none. A new
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
