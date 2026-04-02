import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConnect = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    close: mockClose,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

import { mcpTools, _resetClientCache } from "../mcp-tools.js";

describe("mcpTools()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetClientCache();
  });

  it("connects to MCP server and returns tools with correct shape", async () => {
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: "read_file",
          description: "Read a file from disk",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });

    const tools = await mcpTools({ server: "http://localhost:3001/mcp" });

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "read_file",
      description: "Read a file from disk",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      type: "mcp",
      server: "http://localhost:3001/mcp",
    });
    expect(typeof tools[0]!.handler).toBe("function");
  });

  it("handler proxies callTool to MCP server and returns result", async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: "greet", description: "Greet", inputSchema: {} }],
    });
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "Hello, Alice!" }],
    });

    const tools = await mcpTools({ server: "http://localhost:3001/mcp" });
    const result = await tools[0]!.handler({ name: "Alice" });

    expect(mockCallTool).toHaveBeenCalledWith({ name: "greet", arguments: { name: "Alice" } });
    expect(result).toEqual({ content: [{ type: "text", text: "Hello, Alice!" }] });
  });

  it("handler returns error object when MCP server is unreachable", async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: "greet", description: "Greet", inputSchema: {} }],
    });
    mockCallTool.mockRejectedValue(new Error("ECONNREFUSED"));

    const tools = await mcpTools({ server: "http://localhost:3001/mcp" });
    const result = await tools[0]!.handler({ name: "Alice" });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("ECONNREFUSED") }],
    });
  });

  it("reuses MCP client for same server URI", async () => {
    mockListTools.mockResolvedValue({ tools: [] });

    await mcpTools({ server: "http://localhost:3001/mcp" });
    await mcpTools({ server: "http://localhost:3001/mcp" });

    // connect called only once for same URI
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("creates separate clients for different server URIs", async () => {
    mockListTools.mockResolvedValue({ tools: [] });

    await mcpTools({ server: "http://localhost:3001/mcp" });
    await mcpTools({ server: "http://localhost:3002/mcp" });

    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it("paginates through all tools when nextCursor present", async () => {
    mockListTools
      .mockResolvedValueOnce({
        tools: [{ name: "tool_a", description: "A", inputSchema: {} }],
        nextCursor: "page2",
      })
      .mockResolvedValueOnce({
        tools: [{ name: "tool_b", description: "B", inputSchema: {} }],
      });

    const tools = await mcpTools({ server: "http://localhost:3001/mcp" });

    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(["tool_a", "tool_b"]);
    expect(mockListTools).toHaveBeenCalledTimes(2);
    expect(mockListTools).toHaveBeenCalledWith({ cursor: "page2" });
  });

  it("returns tools with empty parameters when inputSchema is undefined", async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: "no_schema", description: "No schema" }],
    });

    const tools = await mcpTools({ server: "http://localhost:3001/mcp" });
    expect(tools[0]!.parameters).toEqual({});
  });
});
