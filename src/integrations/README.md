# `src/integrations/`

External-protocol surfaces for Ratel. Each entry is a workspace package that wraps `@ratel-ai/sdk` (or `ratel-ai-core` directly) and either speaks one specific protocol, hosts one specific runtime, or drives the rest from a user-facing CLI. MCP is the first protocol Ratel ships against because the largest pool of agent hosts already speaks it; nothing in the platform's design ties it to MCP, and additional surfaces land here as the [roadmap](../../docs/roadmap.md) widens.

Integrations are independent packages; they don't add functionality to the SDK, they expose it.

The companion **`@ratel-ai/mcp-server`** library — exposes a `ToolCatalog` as an MCP server with OAuth 2.1 / PKCE for HTTP & SSE upstreams — used to live here. It now ships from a sibling repo: [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp). The CLI below depends on its published npm artifact.

## Layout

```
cli/           @ratel-ai/cli       — `ratel` CLI: manage MCP scopes, run the gateway, import from Claude Code
```

## `cli/` — `@ratel-ai/cli`

The `ratel` binary. Verbs are grouped:
- `ratel serve` runs the gateway over stdio against one or more Ratel configs.
- `ratel mcp add` mirrors `claude mcp add` — copy-pasted invocations behave identically on both sides.
- `ratel mcp import` / `link` migrate Claude Code's existing MCP setup into Ratel's three-scope (user/project/local) hierarchy.

See [`cli/README.md`](cli/README.md).
