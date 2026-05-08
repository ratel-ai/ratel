import { describe, expect, it } from "vitest";
import {
  type ExecutableTool,
  INVOKE_TOOL_ID,
  invokeToolTool,
  SEARCH_TOOLS_ID,
  type SearchToolsResult,
  searchToolsTool,
  ToolCatalog,
} from "./index.js";

const readFile: ExecutableTool = {
  id: "fs__read_file",
  name: "read_file",
  description: "Read a file from local disk.",
  inputSchema: {
    properties: { path: { type: "string", description: "path to read" } },
  },
  outputSchema: {},
  execute: async ({ path }) => ({ contents: `contents of ${path}` }),
};

const sendEmail: ExecutableTool = {
  id: "mail__send_email",
  name: "send_email",
  description: "Send an email via SMTP.",
  inputSchema: {
    properties: {
      to: { type: "string" },
      body: { type: "string" },
    },
  },
  outputSchema: {},
  execute: async ({ to }) => ({ messageId: "abc", to }),
};

describe("searchToolsTool tracing", () => {
  it("emits gateway_search with origin=agent and the hit count", async () => {
    const catalog = new ToolCatalog({ trace: { kind: "memory", sessionId: "t" } });
    catalog.register(readFile);
    catalog.drainTraceEvents();

    const tool = searchToolsTool(catalog);
    await tool.execute({ query: "read a file", topK: 3 });

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const gw = events.find((e) => e.type === "gateway_search");
    expect(gw).toBeDefined();
    expect(gw?.origin).toBe("agent");
    expect(gw?.top_k).toBe(3);
    expect(typeof gw?.hits).toBe("number");
  });
});

describe("searchToolsTool", () => {
  it("uses the canonical id and name", () => {
    const catalog = new ToolCatalog();
    const tool = searchToolsTool(catalog);
    expect(tool.id).toBe(SEARCH_TOOLS_ID);
    expect(tool.name).toBe(SEARCH_TOOLS_ID);
    expect(SEARCH_TOOLS_ID).toBe("search_tools");
  });

  it("groups hits by upstream server (derived from toolId prefix) with description and inputSchema", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    catalog.register(sendEmail);

    const tool = searchToolsTool(catalog);
    const result = (await tool.execute({ query: "read a file", topK: 5 })) as SearchToolsResult;

    expect(result.groups.length).toBeGreaterThan(0);
    const top = result.groups[0];
    expect(top.server.name).toBe("fs");
    const topHit = top.hits[0];
    expect(topHit.toolId).toBe("fs__read_file");
    expect(topHit.description).toContain("Read");
    expect(topHit.inputSchema).toBeDefined();
  });

  it("includes the upstream server's description in each group's server block", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const tool = searchToolsTool(catalog, {
      upstreamServers: [{ name: "fs", description: "filesystem helpers" }],
    });
    const result = (await tool.execute({ query: "read a file" })) as SearchToolsResult;

    const fsGroup = result.groups.find((g) => g.server.name === "fs");
    expect(fsGroup?.server.description).toBe("filesystem helpers");
  });

  it("omits server.description when no matching upstream metadata is supplied", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const tool = searchToolsTool(catalog);
    const result = (await tool.execute({ query: "read a file" })) as SearchToolsResult;

    const fsGroup = result.groups.find((g) => g.server.name === "fs");
    expect(fsGroup?.server.description).toBeUndefined();
  });

  it("includes the raw upstream instructions on the group's server block, alongside any user description", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const tool = searchToolsTool(catalog, {
      upstreamServers: [
        {
          name: "fs",
          description: "filesystem helpers",
          instructions: "Use this MCP for safe local file IO. Paths must be absolute.",
        },
      ],
    });
    const result = (await tool.execute({ query: "read a file" })) as SearchToolsResult;
    const fsGroup = result.groups.find((g) => g.server.name === "fs");
    expect(fsGroup?.server.description).toBe("filesystem helpers");
    expect(fsGroup?.server.instructions).toBe(
      "Use this MCP for safe local file IO. Paths must be absolute.",
    );
  });

  it("omits server.instructions when the upstream did not provide any", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const tool = searchToolsTool(catalog, {
      upstreamServers: [{ name: "fs", description: "filesystem helpers" }],
    });
    const result = (await tool.execute({ query: "read a file" })) as SearchToolsResult;
    const fsGroup = result.groups.find((g) => g.server.name === "fs");
    expect(fsGroup?.server.instructions).toBeUndefined();
  });

  it("defaults topK to 5 when not provided", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const tool = searchToolsTool(catalog);
    const result = (await tool.execute({ query: "read a file" })) as SearchToolsResult;
    expect(Array.isArray(result.groups)).toBe(true);
  });

  it("description is unchanged when upstreamServers is empty or omitted", () => {
    const catalog = new ToolCatalog();
    const baseline = searchToolsTool(catalog).description;
    expect(searchToolsTool(catalog, {}).description).toBe(baseline);
    expect(searchToolsTool(catalog, { upstreamServers: [] }).description).toBe(baseline);
  });

  it("description appends a list of upstream MCP servers with name, optional desc, optional tool count", () => {
    const catalog = new ToolCatalog();
    const baseline = searchToolsTool(catalog).description;

    const tool = searchToolsTool(catalog, {
      upstreamServers: [
        { name: "ev", description: "file & shell utilities", toolCount: 12 },
        { name: "linear", description: "Linear ticket ops" },
        { name: "metrics", toolCount: 3 },
        { name: "bare" },
      ],
    });

    expect(tool.description.startsWith(baseline)).toBe(true);
    expect(tool.description).toContain("upstream MCP servers");
    expect(tool.description).toContain("- ev — file & shell utilities (12 tools)");
    expect(tool.description).toContain("- linear — Linear ticket ops");
    expect(tool.description).not.toContain("- linear — Linear ticket ops (");
    expect(tool.description).toContain("- metrics (3 tools)");
    expect(tool.description).toMatch(/- bare\b/);
    expect(tool.description).not.toContain("- bare —");
    expect(tool.description).not.toContain("- bare (");
  });

  it("truncates per-upstream descriptions longer than ~160 chars and appends an ellipsis", () => {
    const catalog = new ToolCatalog();
    const long =
      "Use this server to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot.";
    const tool = searchToolsTool(catalog, {
      upstreamServers: [{ name: "context7", description: long, toolCount: 2 }],
    });
    const lines = tool.description.split("\n");
    const c7 = lines.find((l) => l.startsWith("- context7"));
    expect(c7).toBeDefined();
    // The full long text must NOT be present.
    expect(tool.description).not.toContain(long);
    // The line should end with ellipsis followed by tool count.
    expect(c7 ?? "").toMatch(/…\s+\(2 tools\)$/);
    // Total line length should be capped, leaving room for the count suffix.
    expect((c7 ?? "").length).toBeLessThan(200);
  });

  it("collapses multi-line descriptions (newlines and runs of whitespace) into a single line", () => {
    const catalog = new ToolCatalog();
    const multiline = "First line of description.\n\nSecond paragraph that should be collapsed.";
    const tool = searchToolsTool(catalog, {
      upstreamServers: [{ name: "x", description: multiline, toolCount: 1 }],
    });
    const c = tool.description.split("\n").find((l) => l.startsWith("- x"));
    expect(c).toBeDefined();
    expect(c).not.toMatch(/\n/);
    // The collapsed form should fit on one line and contain text from both paragraphs (or be truncated, but not contain a literal newline).
    expect(c).toContain("First line");
  });

  it("does not modify a short single-line description", () => {
    const catalog = new ToolCatalog();
    const tool = searchToolsTool(catalog, {
      upstreamServers: [{ name: "x", description: "short and sweet", toolCount: 1 }],
    });
    expect(tool.description).toContain("- x — short and sweet (1 tools)");
  });

  it("appends a `(auth required)` suffix on upstreams flagged as needsAuth", () => {
    const catalog = new ToolCatalog();
    const tool = searchToolsTool(catalog, {
      upstreamServers: [
        { name: "stripe", description: "billing", toolCount: 7, needsAuth: true },
        { name: "fs", toolCount: 2 },
      ],
    });
    const lines = tool.description.split("\n");
    const stripe = lines.find((l) => l.startsWith("- stripe"));
    const fs = lines.find((l) => l.startsWith("- fs"));
    expect(stripe).toMatch(/\(auth required\)/);
    expect(fs).not.toMatch(/auth required/);
  });
});

describe("invokeToolTool", () => {
  it("uses the canonical id and name", () => {
    const catalog = new ToolCatalog();
    const tool = invokeToolTool(catalog);
    expect(tool.id).toBe(INVOKE_TOOL_ID);
    expect(tool.name).toBe(INVOKE_TOOL_ID);
    expect(INVOKE_TOOL_ID).toBe("invoke_tool");
  });

  it("invokes a registered tool by id with nested args", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const tool = invokeToolTool(catalog);
    const result = await tool.execute({ toolId: "fs__read_file", args: { path: "/tmp/x" } });
    expect(result).toEqual({ contents: "contents of /tmp/x" });
  });

  it("tolerates flattened args (model serialization quirk)", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    const tool = invokeToolTool(catalog);
    const result = await tool.execute({ toolId: "fs__read_file", path: "/tmp/y" });
    expect(result).toEqual({ contents: "contents of /tmp/y" });
  });

  it("returns an error object for unknown toolId", async () => {
    const catalog = new ToolCatalog();

    const tool = invokeToolTool(catalog);
    const result = (await tool.execute({ toolId: "nope", args: {} })) as { error: string };
    expect(result.error).toMatch(/unknown toolId: nope/);
  });

  it("returns an error object when the underlying tool throws", async () => {
    const catalog = new ToolCatalog();
    catalog.register({
      id: "boom",
      name: "boom",
      description: "always throws",
      inputSchema: {},
      outputSchema: {},
      execute: async () => {
        throw new Error("kaboom");
      },
    });

    const tool = invokeToolTool(catalog);
    const result = (await tool.execute({ toolId: "boom", args: {} })) as { error: string };
    expect(result.error).toMatch(/boom threw: kaboom/);
  });

  it("returns a needs_auth payload when the underlying tool throws UnauthorizedError", async () => {
    const catalog = new ToolCatalog();
    class UnauthorizedError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "UnauthorizedError";
      }
    }
    catalog.register({
      id: "stripe__charges",
      name: "stripe__charges",
      description: "...",
      inputSchema: {},
      outputSchema: {},
      execute: async () => {
        throw new UnauthorizedError("token expired");
      },
    });

    const tool = invokeToolTool(catalog);
    const result = (await tool.execute({ toolId: "stripe__charges", args: {} })) as {
      error: string;
      upstream?: string;
      hint?: string;
    };
    expect(result.error).toBe("needs_auth");
    expect(result.upstream).toBe("stripe");
    expect(result.hint).toMatch(/auth tool/i);
  });

  it("invokes onUnauthorized once with the inferred upstream when configured", async () => {
    const catalog = new ToolCatalog();
    class UnauthorizedError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "UnauthorizedError";
      }
    }
    catalog.register({
      id: "stripe__charges",
      name: "stripe__charges",
      description: "...",
      inputSchema: {},
      outputSchema: {},
      execute: async () => {
        throw new UnauthorizedError("token expired");
      },
    });

    const seen: string[] = [];
    const tool = invokeToolTool(catalog, { onUnauthorized: (upstream) => seen.push(upstream) });
    await tool.execute({ toolId: "stripe__charges", args: {} });
    expect(seen).toEqual(["stripe"]);
  });

  it("emits gateway_invoke on success with took_ms", async () => {
    const catalog = new ToolCatalog({ trace: { kind: "memory", sessionId: "t" } });
    catalog.register(readFile);
    catalog.drainTraceEvents();

    const tool = invokeToolTool(catalog);
    await tool.execute({ toolId: "fs__read_file", args: { path: "/x" } });

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const gw = events.find((e) => e.type === "gateway_invoke");
    expect(gw?.tool_id).toBe("fs__read_file");
    expect(typeof gw?.took_ms).toBe("number");
  });

  it("emits gateway_error with `unknown_tool_id` when the toolId is not registered", async () => {
    const catalog = new ToolCatalog({ trace: { kind: "memory", sessionId: "t" } });
    const tool = invokeToolTool(catalog);
    await tool.execute({ toolId: "nope", args: {} });

    const events = catalog.drainTraceEvents() as Array<Record<string, unknown>>;
    const err = events.find((e) => e.type === "gateway_error");
    expect(err?.tool_id).toBe("nope");
    expect(err?.error).toBe("unknown_tool_id");
  });

  it("does not call onUnauthorized for a non-namespaced toolId since the upstream cannot be inferred", async () => {
    const catalog = new ToolCatalog();
    class UnauthorizedError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "UnauthorizedError";
      }
    }
    catalog.register({
      id: "loose",
      name: "loose",
      description: "...",
      inputSchema: {},
      outputSchema: {},
      execute: async () => {
        throw new UnauthorizedError("token expired");
      },
    });

    const seen: string[] = [];
    const tool = invokeToolTool(catalog, { onUnauthorized: (upstream) => seen.push(upstream) });
    const result = (await tool.execute({ toolId: "loose", args: {} })) as {
      error: string;
      upstream?: string;
    };
    expect(result.error).toBe("needs_auth");
    expect(result.upstream).toBeUndefined();
    expect(seen).toEqual([]);
  });
});
