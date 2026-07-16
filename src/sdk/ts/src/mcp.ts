import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { ExecutableTool, ToolCatalog } from "./catalog.js";
import { traceUpstreamRegister } from "./telemetry.js";

/** Options for {@link registerMcpServer}. */
export interface RegisterMcpServerOptions {
  /**
   * Namespace for the server's tools inside the catalog: each tool is
   * registered as `<name>__<toolName>`. Also the `server` name that trace
   * events and result groups report for these tools.
   */
  name: string;
  /**
   * An MCP client transport for the server (e.g. `StdioClientTransport`,
   * `StreamableHTTPClientTransport`, or an `InMemoryTransport` pair in tests).
   * {@link registerMcpServer} connects it; it must not be connected already.
   */
  transport: Transport;
}

/** What {@link registerMcpServer} returns: the ingested ids plus lifecycle control. */
export interface McpServerHandle {
  /** Namespaced ids (`<name>__<toolName>`) of every tool registered, in server order. */
  toolIds: string[];
  /**
   * The usage instructions the server declared during the MCP initialize
   * handshake, or `undefined` if it declared none. Useful as
   * `UpstreamServerInfo.instructions` when building capability tools.
   */
  serverInstructions: string | undefined;
  /**
   * Close the underlying MCP client connection. The proxied tools stay in the
   * catalog but invoking them after close fails.
   */
  close: () => Promise<void>;
}

/**
 * Ingest an MCP server into a {@link ToolCatalog}: connect over the given
 * transport, list its tools once (no live refresh), and register each as an
 * {@link ToolCatalog.register | executable tool} whose executor proxies
 * `callTool` on the live client. A missing tool description registers as `""`;
 * a missing output schema as `{ type: "object" }`.
 *
 * The whole registration is one `ratel.upstream.register` OTel span and an
 * `upstream_register` local trace event; each later invocation records
 * `upstream_invoke` (or `upstream_error`) alongside the catalog's own events
 * (ADR-0007). Rejects if connecting or listing tools fails.
 *
 * @param catalog - Catalog that receives the proxied tools.
 * @param options - Server name (the id namespace) and transport.
 * @returns A handle with the registered ids, the server's instructions, and
 *   `close()`.
 *
 * @example
 * ```ts
 * import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
 * import { registerMcpServer, ToolCatalog } from "@ratel-ai/sdk";
 *
 * const catalog = new ToolCatalog();
 * const github = await registerMcpServer(catalog, {
 *   name: "github",
 *   transport: new StdioClientTransport({ command: "github-mcp-server" }),
 * });
 * // github.toolIds → ["github__create_issue", "github__get_pull_request", ...]
 * const result = await catalog.invoke("github__create_issue", {
 *   title: "Flaky test on main",
 * });
 * await github.close();
 * ```
 */
export async function registerMcpServer(
  catalog: ToolCatalog,
  options: RegisterMcpServerOptions,
): Promise<McpServerHandle> {
  const { name, transport } = options;
  const transportLabel = transportKind(transport);

  // The whole registration (connect + list + ingest) is one `ratel.upstream.register`
  // span; per-tool invocations later get their own `execute_tool` spans (ADR-0007).
  return traceUpstreamRegister(name, transportLabel, async (reportToolCount) => {
    const client = new Client({ name: "@ratel-ai/sdk", version: "0.0.0" });
    await client.connect(transport);

    const serverInstructions = client.getInstructions();

    const { tools } = await client.listTools();
    reportToolCount(tools.length);
    catalog.recordEvent({
      type: "upstream_register",
      server: name,
      transport: transportLabel,
      tool_count: tools.length,
    });
    const toolIds: string[] = [];
    const registered: ExecutableTool[] = [];
    for (const tool of tools) {
      const id = `${name}__${tool.name}`;
      registered.push({
        id,
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? { type: "object" },
        execute: async (args) => {
          const startedAt = Date.now();
          try {
            const result = await client.callTool({
              name: tool.name,
              arguments: args as Record<string, unknown>,
            });
            catalog.recordEvent({
              type: "upstream_invoke",
              server: name,
              tool_id: id,
              took_ms: Date.now() - startedAt,
            });
            return result;
          } catch (err) {
            catalog.recordEvent({
              type: "upstream_error",
              server: name,
              tool_id: id,
              error: (err as Error).message ?? String(err),
            });
            throw err;
          }
        },
      });
      toolIds.push(id);
    }
    await catalog.register(registered);

    return {
      toolIds,
      serverInstructions,
      close: async () => {
        await client.close();
      },
    };
  });
}

function transportKind(transport: Transport): string {
  const ctor = (transport as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? "unknown";
}
