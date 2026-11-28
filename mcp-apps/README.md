# MCP Apps views

Interactive views the Ratel MCP server shows inside MCP hosts (Claude,
ChatGPT, VS Code…), built from the console's own design system
(`@ratel/design-system`). The server side (resources, tool binding, the
`mcpApps` flag) is in `web/src/lib/mcp/apps/README.md`. This folder is
the `@ratel/mcp-apps` workspace package: web/ depends on it and reads only its
built `dist/views.json`.

```
mcp-apps/
├── shell/            shared by every view
│   ├── host-client.ts  the MCP Apps wire protocol, View side (no zod; see the file)
│   ├── bridge.tsx      <RatelViewProvider>, useRatelView(): state, binding, callTool,
│   │                   openInConsole, askAgent, setContext; host theme → data-theme
│   ├── host-adapt.ts   where hosts differ: frame size and insets, display modes,
│   │                   unsupported tools/call, open-link, message
│   ├── state.ts        the view's states as a reducer (connecting, partial, waiting,
│   │                   ready, error, cancelled) over Ratel's result envelope
│   ├── view-frame.tsx  skeleton, error and cancelled rendered the DS way
│   ├── view.css        web/src/app/globals.css + the light set of the --ds-* tokens
│   └── shims/          next/link and next/navigation, the only next/* a view reaches
├── harness/host.ts   the dev harness's host (ext-apps' AppBridge)
├── scripts/          build.mts (the view build), harness.mts (the dev harness)
├── index.mjs         VIEWS_PATH: where the build writes dist/views.json
├── views/<view>/
│   ├── main.tsx        mountView({ name, bindings }, <View />)
│   ├── bindings.ts     default export: { title, description, bindings[] }
│   └── fixtures.ts     default export: scenarios for the harness
└── dist/             built output (gitignored): <view>.html, views.json
```

## Commands

- `pnpm --filter @ratel/mcp-apps build` builds every view into `dist/<view>.html` (script and
  styles inlined, nothing fetched) and `dist/views.json` (what the server serves).
  web's `build`, `dev`, `typecheck` and `test` run it first (`pnpm mcp-apps:build` there).
  web reads only `dist/views.json`, through this package's `VIEWS_PATH` (`index.mjs`).
- `pnpm --filter @ratel/mcp-apps test` builds the views, then runs this package's tests.
- `pnpm --filter @ratel/mcp-apps typecheck`: the views import the console's code as `@/`
  (`../web/src`, `tsconfig.json`), as the private modules do.
- `pnpm --filter @ratel/mcp-apps dev` opens the harness on `http://localhost:4180`: any view, any
  fixture, light and dark side by side, rebuilt on every reload.

## Try them in Claude Desktop (local)

Upstream's one-command setup (`scripts/mcp-apps-local.mts`) is not here yet: it
seeds through demo scripts this repo does not carry. By hand:

- turn the `mcpApps` flag on (`FF_MCP_APPS=1`, or `RATEL_EXPERIMENTAL_FEATURES=1`) in
  `web/.env.local` and start the app (`pnpm --filter @ratel/platform dev`);
- seed a project with runs (`pnpm --filter @ratel/platform seed`) and create a
  project API key for it in the console;
- copy the Claude Desktop entry from the project's Integrations page (it runs
  `mcp-remote`, which bridges Claude Desktop's stdio to `<app>/api/mcp`), merge
  it into `mcpServers` in `claude_desktop_config.json`, quit Claude Desktop (⌘Q)
  and open it again.

The key lives only in your local database and that config; never commit it.

One prompt per view, in a new chat with the server on:

| View | Prompt |
|---|---|
| list | "List the traces of my Ratel project from the last 30 days." Click a run: its detail opens in the panel. |
| detail | "Show the Ratel project overview." |
| series | "Show my Ratel cost by day for the last 30 days." |
| health | "Show my agent's health in Ratel." Open an issue, then "Ask the agent to fix it". |
| overview | "Show the Overview of my Ratel project.", "Show only the Health score.", or "List the changes of my Overview layout." Needs `focusedConsole`. |
| replay | "Replay my latest Ratel session." Press Play, then fullscreen. |

## Rules

- Import `@ratel/design-system/*` directly. When a DS component does not work in a
  view, make the component more portable; never copy it here
  (`build.test.ts` checks).
- Each view stays under 490 KB (Geist is ~62 KB of it, the console's
  globals.css ~17 KB more than the DS alone), or the `budgetKb` its
  `bindings.ts` declares with a reason (`build.test.ts`; the list view's is
  630 KB). The budget is
  ours, a guard against size regressions, not a host limit. React is most of
  it; a new dependency must earn its bytes.
- Views read their data from the result's `structuredContent` (the
  `{ ok, data, truncated?, … }` envelope) and their config from their binding:
  `useRatelView().binding.config`.
- A link to a console page (`/projects/…`) opens on this app's console (the
  origin the server writes into the view, else app.ratel.sh) through the
  host; `?peek=` links stay in the view.
- Fonts: the console's Geist comes from next/font, which a view cannot load.
  The build inlines Geist and Geist Mono from the `geist` package, cut to the
  latin range and weights 400–600 (~62 KB of base64 for both, in every view).

## Host differences

Hosts fill the optional parts of the host context differently and support
different requests; `shell/host-adapt.ts` absorbs that, so views never test
for a host:

- Theme: a view follows the host's light or dark theme and nothing else of
  its styles: no host fonts, page color or variables. It looks like the
  console, in Geist on the console's app surface.
- Size: `--host-height` (fullscreen), `--host-max-height`, `--host-width`, and
  `--host-safe-*` insets; a value the host stops sending is removed.
- Display modes: the views declare inline and fullscreen at `ui/initialize`;
  a mode the host did not offer is never requested.
- tools/call: a host without it reads as `host_unsupported` (or
  `host_timeout`), not as a failed tool.
- open-link falls back to a new window where the host has none; a host that
  refuses is final. `askAgent` and `setContext` resolve to false, never throw.

## The dashboard view

`views/dashboard` draws `get_dashboard` and `query_monitoring` with the console's own `WidgetBody`,
from the widgets and results in the tool's `view`, on the stored 12-column grid, read-only. A host
that passes the text only gets a table of one line per widget. `query_monitoring` with `queries`
shows two to four results side by side, and Open in Ratel opens the same in Explore. A widget with a
group-by (RTL-398) is a list of its values, each with its traces and its numbers in one line
(`groups-table.tsx`): one small chart per value does not fit a cell of a view. Clusters are a table with a link to
the console: the Intents map's drawings bring about 150 KB. The view is 733 KB:
the map's shapes are about 210 KB of it.

The overview view draws the dashboard widgets that are on an Overview with the same bodies, and the
same table for clusters. It is 787 KB for that reason, now the largest one.

`shell/shims/zod.ts` and `node-crypto.ts` stand in for `zod` and `node:crypto` in every view: the
console's modules declare schemas as they load, and a view parses nothing.

## Generic views

Most tools need no UI code: add a binding to one of these.

| View | Binds | Config (`shell/config.ts`) |
|---|---|---|
| `list` | `list_traces`, `list_intents`, `list_tasks`, `list_fixes`, `list_insights`, `list_skills`, `list_shipments`, `list_sdk_events`, `list_logs`, `list_projects`, `list_span_groups`, `list_invoked_tools`, `list_declared_tools`, `list_scorers`, `list_alerts`, `list_alert_destinations`, `list_slack_channels`, `get_location_attributes`, `list_dashboards` | rows path, row key, columns, search keys, filters, default sort, the tool's own sort argument (`sortArg`), cursor, detail tool and its args (read from the row; the bridge names the project), and optionally the view model to draw from (`fromView`) |
| `detail` | `get_intent`, `get_task`, `get_fix`, `get_skill`, `get_sdk_event`, `get_project_overview`, `get_scorer`, `get_alert` | root path, title, fields, sections (fields, table, list), console link |
| `series` | `get_cost_by_day`, `get_trace_health` | rows path, x, one measure, 2 to 5 stats (`aggregate: "window"` reads the tool's own figure from `data`), empty text |

Each bound tool has harness fixtures named `<tool>`, `<tool> · dense` and
`<tool> · empty`; `views/bindings.test.ts` checks the binding reads them (rows,
columns, filters, detail arguments), so a wrong path fails a test rather than
showing a blank column.

Left out, on purpose:

- `get_cost_by_tool`: the operation spreads one tools-by-name map per event
  into rows named "0", "1"…; it needs a fold by tool before it binds.
  `list_invoked_tools` is the per-tool breakdown meanwhile.
- `get_lineage`: its shape changes with `chain`, and a list cannot pass the
  fixed `kind` it needs; `list_shipments` has no detail.
- `get_embedding_usage`: totals and a wallet, no per-day rows for the series.

Cell formats (`shell/format.ts`, `shell/cells.tsx`): text, number, currency
(`null` is "Unpriced", never $0), duration, date, percent, badge, entity pin,
inline bar, id. A field marked `content: true` reads "Redacted" when the result
says `contentWithheld`. The list opens a row's detail tool through tools/call
in the DS Panel, rendered with that tool's detail binding.

A view shows what its console page shows. Three rules keep it so:

- **Numbers go through the page's formatter.** Where a page rounds its own way,
  the binding names a format that calls that page's function: `share` and
  `per100` (the task pages' self-corrections per 100 turns,
  `lib/tasks/format.ts`), `whole` and `meter` (the
  intent pages' whole percent), `taskCost` (a task's cost per run) and `points`
  (Agent health's "If fixed"). Do not reach for `percent` on a page that does
  not print the Traces page's percent.
- **The tool's sort is the list's order.** When a call names a `sort`, the tool
  ordered the whole set and returned a page of it, so the list keeps that order
  and marks the column `sortArg` maps the value to. Without one, the binding's
  `defaultSort` applies. A header click sorts the rows the view has.
- **A list whose page groups its rows draws from the view model.** `list_insights`
  returns every issue; Agent health lists one row per kind. The server sends the
  page's rows in the result's `view` (`lib/mcp/operations/health.ts`,
  `loadHealthIssueRows`: the page's own `issueRows`), and the binding's
  `fromView` draws the list from them. Without a view model the list is the
  tool's own rows.

## Dedicated views

- `table`: `run_rql` as a table of the RQL query's own columns, each with its RQL type, from the
  tool's `columns` and `rows`. The columns change with each query, so the list view's fixed columns
  do not fit. A cut table and an empty one say so.

- `trace`: `get_trace` as the console's own TraceView (embedded, as the
  session replay's Trace view shows it), from the trace page's props in the
  result's `view` (`lib/traces/v2/trace-view-props.ts`); without captured-text
  access they come without messages, payloads or queries. With no `view` it
  reads as the generic detail. The list view's Panel still opens a trace row
  with the detail binding.
- `overview`: `get_overview` as the recap Overview (`focusedConsole`): the console's own widget
  bodies (`components/console/home/focused/widget-bodies`) from the page's own data in the result's
  `view`, in the person's places, with the hidden widgets absent, or one widget alone (`widget`).
  `change_overview_layout`, `undo_overview_change` and `restore_overview_layout` draw the Overview that
  they made, and `list_overview_changes` the console's own History list. Nothing is arranged in the view.
  It is published only when the tool exists.
- `replay`: the console's own session replay (`components/session-chat`:
  SessionChatView, SessionTrack with playback, StepInspector), from the same
  SessionChat as `/sessions/[sessionId]`. `get_session`, `get_run_summary`
  and `get_trace_conversation` carry it in their result's `view`
  (`lib/mcp/operations/session-chat-view.ts`), which reaches
  structuredContent only, never the agent's text; a run opens on its own
  turn. The inspector reads a step's text with `get_session_step_content`, an
  app-only tool (listed only with the `mcpApps` flag on, `visibility: ["app"]`).
  Opening a step or a turn sends `ui/update-model-context`; fullscreen goes
  through `requestDisplayMode`. A `"use server"` module a console component
  imports reaches a view as a stub (`scripts/build.mts`).
