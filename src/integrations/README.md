# `src/integrations/`

External-protocol surfaces for Ratel. Each entry is a workspace package that wraps `@ratel-ai/sdk` (or `ratel-ai-core` directly) and either speaks one specific protocol, hosts one specific runtime, or drives the rest from a user-facing CLI. MCP is the first protocol Ratel ships against because the largest pool of agent hosts already speaks it; nothing in the platform's design ties it to MCP, and additional surfaces land here as the [roadmap](../../docs/roadmap.md) widens.

Integrations are independent packages; they don't add functionality to the SDK, they expose it.

## Layout

```
mcp-server/    @ratel-ai/mcp-server — library that exposes a ToolCatalog as a Model Context Protocol server
cli/           @ratel-ai/cli       — `ratel` CLI: manage MCP scopes, run the gateway, import from Claude Code
```

## `mcp-server/` — `@ratel-ai/mcp-server`

Library function that takes a `ToolCatalog` plus a caller-supplied MCP `Transport` and exposes the gateway (`search_tools` + `invoke_tool`) over the protocol. The inverse of `@ratel-ai/sdk`'s `registerMcpServer`. Ships `buildGatewayFromConfig` and `parseConfig` alongside `createMcpServer` for higher-level callers. See [`mcp-server/README.md`](mcp-server/README.md).

## `cli/` — `@ratel-ai/cli`

The `ratel` binary. Verbs are grouped:
- `ratel mcp serve` runs the gateway over stdio against one or more Ratel configs.
- `ratel mcp add` mirrors `claude mcp add` — copy-pasted invocations behave identically on both sides.
- `ratel mcp import` / `link` migrate Claude Code's existing MCP setup into Ratel's three-scope (user/project/local) hierarchy.

See [`cli/README.md`](cli/README.md).
