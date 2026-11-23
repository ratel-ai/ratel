# MCP Apps on the Ratel MCP server

Interactive views for MCP hosts (Claude, ChatGPT, VS Code…), per the MCP Apps
extension (SEP-1865). Behind the `FF_MCP_APPS` switch (`flag.ts`), one switch
for the whole deployment and off by default (`RATEL_EXPERIMENTAL_FEATURES`
turns it on too in the open-source edition). With it off the server is exactly
what it was: `route-handler.apps.test.ts` pins initialize, tools/list and
resources/list against `../__fixtures__/flag-off-protocol.json`.

## How it fits

- **Views** are built from `mcp-apps/views/<view>/` (the `@ratel/mcp-apps` package) into one
  self-contained HTML document each (`pnpm --filter @ratel/mcp-apps build`). The build writes
  `mcp-apps/dist/views.json` (gitignored): an array of
  `McpAppView` (`types.ts`): `{ view, title?, description?, html, bindings[] }`.
- **Bindings** live next to each view in `views/<view>/bindings.ts`: the tools
  that view renders, each with a view-specific `config` (columns, filters,
  formats). The server never reads `config`.
- **Load** (`load.ts`): read once per process and checked against every tool
  the server can register (`catalog.ts`). A binding to a tool that does not
  exist, or a tool bound to two views, throws `McpAppCatalogError`; tests and
  the build fail on it. At request time a failed load is logged and reported,
  and the caller gets the server without views.
- **Serve** (`../server.ts`): each view is a resource `ui://ratel/<view>`,
  `text/html;profile=mcp-app`, over the same `POST /api/mcp` and the same auth,
  rate limits and launch access as tools. A bound tool's `_meta` gains
  `ui.resourceUri` next to its `sh.ratel/stage`. `resources/read` outcomes are
  logged (`mcp resource read`, `mcp resource read refused`).
- **Clients** (`client-views.ts`): the server is stateless, so whether a client
  shows views travels in the session id issued at its `initialize`
  (`ratel-views-<uuid>`), or in the capabilities a request carries.

## How a view receives its binding config

The config is **baked into the view** and **picked by tool name**:

1. The view bundle imports its own `bindings.ts`, so every binding's config is
   in the HTML. Nothing extra travels with each tool result.
2. The bridge picks the binding by the tool that rendered it: first the host's
   `ui/initialize` `hostContext.toolInfo.tool.name`; when a host does not send
   it, the tool result's `_meta["sh.ratel/binding"]` (`{ view, tool }`), which
   the server sets on every bound tool's result while the switch is on.

The result's text content and `structuredContent` are unchanged; the view reads
its data from `structuredContent`.

## The view's own model

Some tools load more for their view than the model needs (get_trace's TraceView
props, get_session's SessionChat): `OperationResult.view`. The server puts it in
the result's `_meta["sh.ratel/view"]`, never in content or `structuredContent`,
because hosts pass those two to the model and `_meta` only to the view. So
content and `structuredContent` are byte-identical with the switch on or off.
The shell (`mcp-apps/shell/state.ts` readToolResult) puts it back on the result
a view sees as `result.view`, for results from the host and from the view's own
tool calls alike.

## Adding a view to a tool

Add `{ tool: "<operation id>", config }` to the view's `bindings.ts`. Nothing on
the server changes.
