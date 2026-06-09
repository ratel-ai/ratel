import { describe, expect, it } from "vitest";
import {
  type ExecutableTool,
  INVOKE_TOOL_ID,
  invokeToolTool,
  SEARCH_CAPABILITIES_ID,
  type SearchCapabilitiesResult,
  type Skill,
  SkillCatalog,
  searchCapabilitiesTool,
  ToolCatalog,
} from "./index.js";

const readFile: ExecutableTool = {
  id: "fs__read_file",
  name: "read_file",
  description: "Read a file from local disk.",
  inputSchema: { properties: { path: { type: "string", description: "path to read" } } },
  outputSchema: {},
  execute: async ({ path }) => ({ contents: `contents of ${path}` }),
};

const sendEmail: ExecutableTool = {
  id: "mail__send_email",
  name: "send_email",
  description: "Send an email via SMTP.",
  inputSchema: { properties: { to: { type: "string" } } },
  outputSchema: {},
  execute: async ({ to }) => ({ messageId: "abc", to }),
};

function skillCatalogWith(...skills: Skill[]): SkillCatalog {
  const c = new SkillCatalog();
  for (const s of skills) c.register(s);
  return c;
}

const vercelSkill: Skill = {
  id: "vercel-deploy",
  name: "vercel-deploy",
  description: "How to deploy to Vercel: env vars, preview vs production, rollbacks.",
  tags: ["vercel", "deployment"],
  body: "# Vercel Deploy",
};

describe("searchCapabilitiesTool", () => {
  it("uses the canonical id and name", () => {
    const tool = searchCapabilitiesTool(new ToolCatalog());
    expect(tool.id).toBe(SEARCH_CAPABILITIES_ID);
    expect(SEARCH_CAPABILITIES_ID).toBe("search_capabilities");
  });

  it("returns tools grouped by server and an empty skills bucket when no skill catalog", async () => {
    const tools = new ToolCatalog();
    tools.register(readFile);
    tools.register(sendEmail);
    const tool = searchCapabilitiesTool(tools);

    const result = (await tool.execute({ query: "read a file" })) as SearchCapabilitiesResult;
    expect(result.tools.groups[0].server.name).toBe("fs");
    expect(result.tools.groups[0].hits[0].toolId).toBe("fs__read_file");
    expect(result.skills).toEqual([]);
  });

  it("returns a skills bucket alongside tools when a skill catalog is wired", async () => {
    const tools = new ToolCatalog();
    tools.register(readFile);
    const tool = searchCapabilitiesTool(tools, skillCatalogWith(vercelSkill));

    const result = (await tool.execute({ query: "deploy to vercel" })) as SearchCapabilitiesResult;
    expect(result.skills[0]?.skillId).toBe("vercel-deploy");
    expect(result.skills[0]?.description).toContain("Vercel");
  });

  it("never starves skills: many matching tools do not crowd the skill out of its own bucket", async () => {
    const tools = new ToolCatalog();
    for (let i = 0; i < 8; i++) {
      tools.register({
        id: `deploy__tool_${i}`,
        name: `deploy_${i}`,
        description: "deploy the project to production",
        inputSchema: {},
        outputSchema: {},
        execute: async () => ({}),
      });
    }
    const tool = searchCapabilitiesTool(tools, skillCatalogWith(vercelSkill));

    const result = (await tool.execute({
      query: "deploy to production",
      topKTools: 5,
      topKSkills: 3,
    })) as SearchCapabilitiesResult;
    // tools bucket capped at 5, skills bucket independently retains the skill
    const toolCount = result.tools.groups.reduce((n, g) => n + g.hits.length, 0);
    expect(toolCount).toBeLessThanOrEqual(5);
    expect(result.skills.map((s) => s.skillId)).toContain("vercel-deploy");
  });

  it("includes upstream server description in the tool group", async () => {
    const tools = new ToolCatalog();
    tools.register(readFile);
    const tool = searchCapabilitiesTool(tools, undefined, {
      upstreamServers: [{ name: "fs", description: "filesystem helpers" }],
    });
    const result = (await tool.execute({ query: "read a file" })) as SearchCapabilitiesResult;
    expect(result.tools.groups.find((g) => g.server.name === "fs")?.server.description).toBe(
      "filesystem helpers",
    );
  });

  it("emits gateway_search telemetry for the tool search", async () => {
    const tools = new ToolCatalog({ trace: { kind: "memory", sessionId: "t" } });
    tools.register(readFile);
    tools.drainTraceEvents();
    const tool = searchCapabilitiesTool(tools);
    await tool.execute({ query: "read a file", topKTools: 3 });
    const events = tools.drainTraceEvents() as Array<Record<string, unknown>>;
    const gw = events.find((e) => e.type === "gateway_search");
    expect(gw?.top_k).toBe(3);
  });
});

describe("invokeToolTool", () => {
  it("uses the canonical id and invokes by nested args", async () => {
    const tools = new ToolCatalog();
    tools.register(readFile);
    const tool = invokeToolTool(tools);
    expect(tool.id).toBe(INVOKE_TOOL_ID);
    const result = await tool.execute({ toolId: "fs__read_file", args: { path: "/tmp/x" } });
    expect(result).toEqual({ contents: "contents of /tmp/x" });
  });

  it("tolerates flattened args", async () => {
    const tools = new ToolCatalog();
    tools.register(readFile);
    const tool = invokeToolTool(tools);
    const result = await tool.execute({ toolId: "fs__read_file", path: "/tmp/y" });
    expect(result).toEqual({ contents: "contents of /tmp/y" });
  });

  it("returns a raw result (no relatedSkills wrapping)", async () => {
    const tools = new ToolCatalog();
    tools.register(readFile);
    const tool = invokeToolTool(tools);
    const out = await tool.execute({ toolId: "fs__read_file", args: { path: "/x" } });
    expect(out).toEqual({ contents: "contents of /x" });
  });

  it("returns an error object for unknown toolId", async () => {
    const tool = invokeToolTool(new ToolCatalog());
    const result = (await tool.execute({ toolId: "nope", args: {} })) as { error: string };
    expect(result.error).toMatch(/unknown toolId: nope/);
  });

  it("returns a needs_auth payload + calls onUnauthorized on UnauthorizedError", async () => {
    const tools = new ToolCatalog();
    class UnauthorizedError extends Error {
      constructor(m: string) {
        super(m);
        this.name = "UnauthorizedError";
      }
    }
    tools.register({
      id: "stripe__charges",
      name: "charges",
      description: "...",
      inputSchema: {},
      outputSchema: {},
      execute: async () => {
        throw new UnauthorizedError("expired");
      },
    });
    const seen: string[] = [];
    const tool = invokeToolTool(tools, { onUnauthorized: (u) => seen.push(u) });
    const result = (await tool.execute({ toolId: "stripe__charges", args: {} })) as {
      error: string;
      upstream?: string;
    };
    expect(result.error).toBe("needs_auth");
    expect(result.upstream).toBe("stripe");
    expect(seen).toEqual(["stripe"]);
  });

  it("emits gateway_invoke on success", async () => {
    const tools = new ToolCatalog({ trace: { kind: "memory", sessionId: "t" } });
    tools.register(readFile);
    tools.drainTraceEvents();
    const tool = invokeToolTool(tools);
    await tool.execute({ toolId: "fs__read_file", args: { path: "/x" } });
    const events = tools.drainTraceEvents() as Array<Record<string, unknown>>;
    expect(events.find((e) => e.type === "gateway_invoke")?.tool_id).toBe("fs__read_file");
  });
});
