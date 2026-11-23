# entity-dimensions

Hand-written OTLP/JSON exports for `lib/otlp/dimensions/ingest.integration.test.ts` (RC-772). One trace, sent by two processes:

- `agent.otlp.json`: service `support-app`. A `supervisor` agent invokes a `researcher` agent. The researcher makes one model call and one tool call (`docs__search`), which sends an MCP `tools/call` (a CLIENT span).
- `mcp-server.otlp.json`: service `docs-mcp`. The MCP server's `tools/call` SERVER span (its parent is the client span of the other export) and one inner span.

The two `tools/call` spans carry `mcp.session.id = sess-docs-1`.
