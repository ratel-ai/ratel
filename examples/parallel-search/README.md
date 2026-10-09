# Parallel Search MCP through Ratel

Search the web and optionally fetch a page using [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp). This example connects anonymously over Streamable HTTP, registers the live tool schemas with `registerMcpServer`, BM25-ranks the catalog, and invokes `web_search` and `web_fetch` through `ToolCatalog.invoke`.

No API key or model is needed. The anonymous endpoint is free for exploration and light use, with lower rate limits than authenticated access. This is a direct tool invocation example; it does not run an LLM agent.

## Run

From the repository root, with Rust stable, Node 24+, and pnpm 10.28+ installed:

```bash
pnpm install
pnpm -F @ratel-ai/example-parallel-search start
```

To supply a query and also fetch a specific page:

```bash
pnpm -F @ratel-ai/example-parallel-search start \
  --query "Ratel AI tool retrieval MCP" --url https://ratel.sh
```

The command builds the local telemetry and SDK packages, prints ranked tool IDs and full MCP results as JSON, and closes the connection. Search results include source URLs and excerpts; fetch returns page content. Tool errors produce a nonzero exit code. Both calls share a generated session ID for free-tier rate limiting.

## Layout and checks

- `src/main.ts`: command-line options and result output.
- `src/search.ts`: anonymous transport, tool registration, ranking, invocation, and cleanup.
- `src/search.test.ts`: offline HTTP fixture that verifies discovery, catalog invocation, request headers, and shared session ID.

After the first run has built the SDK:

```bash
pnpm -F @ratel-ai/example-parallel-search typecheck
pnpm -F @ratel-ai/example-parallel-search test
```
