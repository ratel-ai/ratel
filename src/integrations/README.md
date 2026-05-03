# `src/integrations/`

External-protocol surfaces for Ratel. Each entry is a workspace package that wraps `@ratel-ai/sdk` (or `ratel-core` directly) and speaks one specific protocol or hosts one specific runtime, so a `ToolCatalog` can be driven from outside the host process.

Integrations are independent packages; they don't add functionality to the SDK, they expose it.

## Layout

```
mcp-server/    @ratel-ai/mcp-server — exposes a ToolCatalog as a Model Context Protocol server
```

Future integrations (CLI, Claude Code config import) land here when their milestones come up.

## `mcp-server/` — `@ratel-ai/mcp-server`

Library function that takes a `ToolCatalog` plus a caller-supplied MCP `Transport` and exposes the gateway (`search_tools` + `invoke_tool`) over the protocol. The inverse of `@ratel-ai/sdk`'s `registerMcpServer`. See [`mcp-server/README.md`](mcp-server/README.md).
