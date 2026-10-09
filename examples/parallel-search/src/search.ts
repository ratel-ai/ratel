import { randomUUID } from "node:crypto";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerMcpServer, ToolCatalog } from "@ratel-ai/sdk";

export interface SearchOptions {
  query: string;
  url?: string;
  fetch?: typeof fetch;
}

/** Discover live schemas, rank the tools, and invoke them through Ratel's catalog. */
export async function runSearch({ query, url, fetch: fetchImpl }: SearchOptions) {
  const catalog = new ToolCatalog();
  const transport = new StreamableHTTPClientTransport(new URL("https://search.parallel.ai/mcp"), {
    requestInit: { headers: { "User-Agent": "ratel-parallel-search-example/0.0.0" } },
    fetch: fetchImpl,
  });
  const handle = await registerMcpServer(catalog, { name: "parallel", transport });
  const sessionId = randomUUID();
  try {
    const rankedToolIds = catalog
      .search(`Search the web: ${query}`, handle.toolIds.length)
      .map((hit) => hit.toolId);
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const id = rankedToolIds.find((toolId) => toolId === `parallel__${name}`);
      if (!id) throw new Error(`Parallel tool ${name} was not found in the ranked catalog`);
      const result = await catalog.invoke(id, { ...args, session_id: sessionId });
      if ((result as { isError?: boolean }).isError) {
        throw new Error(`Parallel ${name} failed: ${JSON.stringify(result)}`);
      }
      return result;
    };
    const search = await invoke("web_search", { objective: query, search_queries: [query] });
    const page = url
      ? await invoke("web_fetch", { urls: [url], objective: query, search_queries: [query] })
      : undefined;
    return { rankedToolIds, search, ...(page === undefined ? {} : { page }) };
  } finally {
    await handle.close();
  }
}
