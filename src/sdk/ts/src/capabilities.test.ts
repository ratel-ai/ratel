import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
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

// A span test may register a global OTel provider; drop it after every test so it
// can't leak into the others (which assert on the local recordEvent stream).
afterEach(() => trace.disable());

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

  it("pulls a matched skill's declared tools into the tools bucket, additively and deduped", async () => {
    const deployPush: ExecutableTool = {
      id: "vercel__push",
      name: "push",
      description: "Deploy the project to Vercel production.",
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({}),
    };
    const tools = new ToolCatalog();
    tools.register(deployPush); // matches the query "deploy to vercel"
    tools.register(readFile); // declared by the skill but does NOT match the query
    const deployWithDeps: Skill = {
      ...vercelSkill,
      // one dep already query-matched (vercel__push), one not (fs__read_file), one absent
      tools: ["vercel__push", "fs__read_file", "ghost__missing"],
    };
    const tool = searchCapabilitiesTool(tools, skillCatalogWith(deployWithDeps));

    const result = (await tool.execute({
      query: "deploy to vercel",
      topKTools: 5,
      topKSkills: 3,
    })) as SearchCapabilitiesResult;

    const toolIds = result.tools.groups.flatMap((g) => g.hits.map((h) => h.toolId));
    // read_file rode in on the skill even though it never matched the query…
    expect(toolIds).toContain("fs__read_file");
    // …vercel__push appears exactly once (query hit + dep must not double it)…
    expect(toolIds.filter((id) => id === "vercel__push")).toHaveLength(1);
    // …and a declared id the catalog doesn't have is silently skipped.
    expect(toolIds).not.toContain("ghost__missing");
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

  it("clamps a non-positive / non-integer topK back to the default", async () => {
    const tools = new ToolCatalog();
    tools.register(readFile);
    tools.register(sendEmail);
    const tool = searchCapabilitiesTool(tools);
    const count = async (input: object): Promise<number> => {
      const r = (await tool.execute(input)) as SearchCapabilitiesResult;
      return r.tools.groups.reduce((n, g) => n + g.hits.length, 0);
    };
    const q = "read a file or send an email";
    const baseline = await count({ query: q }); // default top-K
    // 0 / negative / fractional must fall back to the default, never return zero
    // tools (TS) or an unbounded set (negative wrapping to u32 in the native layer).
    expect(await count({ query: q, topKTools: 0 })).toBe(baseline);
    expect(await count({ query: q, topKTools: -3 })).toBe(baseline);
    expect(await count({ query: q, topKTools: 1.5 })).toBe(baseline);
    expect(await count({ query: q, topKTools: 1 })).toBe(1); // a valid positive int is honored
  });

  it("advertises skills in its description only when a non-empty skill catalog is wired", () => {
    const tools = new ToolCatalog();
    tools.register(readFile);

    const toolsOnly = searchCapabilitiesTool(tools);
    expect(toolsOnly.description).not.toContain("get_skill_content");
    expect(toolsOnly.description.toLowerCase()).not.toContain("skill");

    const withSkills = searchCapabilitiesTool(tools, skillCatalogWith(vercelSkill));
    expect(withSkills.description).toContain("get_skill_content");

    // an empty catalog is treated as no skills
    const emptyCatalog = searchCapabilitiesTool(tools, new SkillCatalog());
    expect(emptyCatalog.description).not.toContain("get_skill_content");
  });
});

describe("searchCapabilitiesTool skill-dependency expansion (maxDepth)", () => {
  // Depended-on by the vercel skill below; its description shares no terms with
  // the "deploy to vercel" query, so it can only enter the results as a dep.
  const deckOutlining: Skill = {
    id: "deck-outlining",
    name: "deck-outlining",
    description: "Outline the narrative structure of a slide deck.",
    tags: ["outlining"],
    tools: ["fs__read_file"],
    body: "# Deck Outlining",
  };
  const deployWithSkillDep: Skill = { ...vercelSkill, skills: ["deck-outlining"] };

  /** Chain head → l1 → l2 → l3 → l4; only the head matches "deploy to vercel". */
  function chainCatalog(): SkillCatalog {
    const link = (id: string, dep?: string): Skill => ({
      id,
      name: id,
      description: `Unrelated playbook ${id.replace(/-/g, " ")}.`,
      tags: [],
      ...(dep ? { skills: [dep] } : {}),
      body: `# ${id}`,
    });
    return skillCatalogWith(
      { ...vercelSkill, skills: ["chain-l1"] },
      link("chain-l1", "chain-l2"),
      link("chain-l2", "chain-l3"),
      link("chain-l3", "chain-l4"),
      link("chain-l4"),
    );
  }

  it("does not expand deps by default or at an explicit maxDepth: 0", async () => {
    const tools = new ToolCatalog();
    tools.register(readFile);
    const tool = searchCapabilitiesTool(tools, skillCatalogWith(deployWithSkillDep, deckOutlining));
    for (const input of [
      { query: "deploy to vercel" },
      { query: "deploy to vercel", maxDepth: 0 },
    ]) {
      const result = (await tool.execute(input)) as SearchCapabilitiesResult;
      expect(result.skills.map((s) => s.skillId)).toEqual(["vercel-deploy"]);
      // the dep skill stayed out, so its declared tool must not ride in either
      const toolIds = result.tools.groups.flatMap((g) => g.hits.map((h) => h.toolId));
      expect(toolIds).not.toContain("fs__read_file");
    }
  });

  it("maxDepth: 1 appends the dep skill at score 0, beyond the topKSkills budget", async () => {
    const tool = searchCapabilitiesTool(
      new ToolCatalog(),
      skillCatalogWith(deployWithSkillDep, deckOutlining),
    );
    const result = (await tool.execute({
      query: "deploy to vercel",
      topKSkills: 1,
      maxDepth: 1,
    })) as SearchCapabilitiesResult;
    // budget of 1 holds the query hit; the dep rides in additively beyond it
    expect(result.skills.map((s) => s.skillId)).toEqual(["vercel-deploy", "deck-outlining"]);
    expect(result.skills[1].score).toBe(0);
    expect(result.skills[1].description).toContain("narrative structure");
  });

  it("maxDepth: 1 pulls the dep skill's declared tools into the tools bucket at score 0", async () => {
    const tools = new ToolCatalog();
    tools.register(readFile);
    const tool = searchCapabilitiesTool(tools, skillCatalogWith(deployWithSkillDep, deckOutlining));
    const result = (await tool.execute({
      query: "deploy to vercel",
      maxDepth: 1,
    })) as SearchCapabilitiesResult;
    const hit = result.tools.groups
      .flatMap((g) => g.hits)
      .find((h) => h.toolId === "fs__read_file");
    expect(hit, "dep skill's declared tool rode in").toBeTruthy();
    expect(hit?.score).toBe(0);
  });

  it("expands transitively level by level: depth 1 stops at the direct dep, depth 2 reaches its dep", async () => {
    const tool = searchCapabilitiesTool(new ToolCatalog(), chainCatalog());
    const depth1 = (await tool.execute({
      query: "deploy to vercel",
      maxDepth: 1,
    })) as SearchCapabilitiesResult;
    expect(depth1.skills.map((s) => s.skillId)).toEqual(["vercel-deploy", "chain-l1"]);
    const depth2 = (await tool.execute({
      query: "deploy to vercel",
      maxDepth: 2,
    })) as SearchCapabilitiesResult;
    expect(depth2.skills.map((s) => s.skillId)).toEqual(["vercel-deploy", "chain-l1", "chain-l2"]);
  });

  it("terminates on a dependency cycle, listing each skill once", async () => {
    const a: Skill = { ...vercelSkill, skills: ["cycle-b"] };
    const b: Skill = {
      id: "cycle-b",
      name: "cycle-b",
      description: "Unrelated playbook that references its parent skill.",
      tags: [],
      skills: ["vercel-deploy"],
      body: "# Cycle B",
    };
    const tool = searchCapabilitiesTool(new ToolCatalog(), skillCatalogWith(a, b));
    const result = (await tool.execute({
      query: "deploy to vercel",
      maxDepth: 3,
    })) as SearchCapabilitiesResult;
    expect(result.skills.map((s) => s.skillId)).toEqual(["vercel-deploy", "cycle-b"]);
  });

  it("silently skips a declared dep id the catalog doesn't have", async () => {
    const tool = searchCapabilitiesTool(
      new ToolCatalog(),
      skillCatalogWith({ ...vercelSkill, skills: ["ghost-skill"] }),
    );
    const result = (await tool.execute({
      query: "deploy to vercel",
      maxDepth: 1,
    })) as SearchCapabilitiesResult;
    expect(result.skills.map((s) => s.skillId)).toEqual(["vercel-deploy"]);
  });

  it("lists a dep declared by two surfaced skills once", async () => {
    const rollback: Skill = {
      id: "vercel-rollback",
      name: "vercel-rollback",
      description: "Roll back a bad Vercel deployment to the previous build.",
      tags: ["vercel"],
      skills: ["deck-outlining"],
      body: "# Vercel Rollback",
    };
    const tool = searchCapabilitiesTool(
      new ToolCatalog(),
      skillCatalogWith({ ...vercelSkill, skills: ["deck-outlining"] }, rollback, deckOutlining),
    );
    const result = (await tool.execute({
      query: "deploy to vercel",
      maxDepth: 1,
    })) as SearchCapabilitiesResult;
    // both query hits declare the same dep — it rides in exactly once
    expect(result.skills.filter((s) => s.skillId === "deck-outlining")).toHaveLength(1);
  });

  it("seeds expansion from surfaced hits only: a query match cut by the topKSkills budget contributes no deps", async () => {
    const billing: Skill = {
      id: "vercel-billing",
      name: "vercel-billing",
      description: "Understand the Vercel invoice line items.",
      tags: [],
      skills: ["deck-outlining"],
      body: "# Vercel Billing",
    };
    const tool = searchCapabilitiesTool(
      new ToolCatalog(),
      skillCatalogWith(vercelSkill, billing, deckOutlining),
    );
    const result = (await tool.execute({
      query: "deploy to vercel",
      topKSkills: 1,
      maxDepth: 1,
    })) as SearchCapabilitiesResult;
    // budget 1 keeps only the best hit; the cut billing skill's dep must not ride in
    expect(result.skills.map((s) => s.skillId)).toEqual(["vercel-deploy"]);
  });

  it("keeps the query score when a dep is also a query hit, without duplicating it", async () => {
    const rollback: Skill = {
      id: "vercel-rollback",
      name: "vercel-rollback",
      description: "Roll back a bad Vercel deployment to the previous build.",
      tags: ["vercel"],
      body: "# Vercel Rollback",
    };
    const tool = searchCapabilitiesTool(
      new ToolCatalog(),
      skillCatalogWith({ ...vercelSkill, skills: ["vercel-rollback"] }, rollback),
    );
    const result = (await tool.execute({
      query: "deploy to vercel",
      maxDepth: 1,
    })) as SearchCapabilitiesResult;
    const rollbackHits = result.skills.filter((s) => s.skillId === "vercel-rollback");
    expect(rollbackHits).toHaveLength(1);
    expect(rollbackHits[0].score).toBeGreaterThan(0);
  });

  it("records a skill_search event carrying the expansion: deps as hits at score 0, dep_count set", async () => {
    const skillCatalog = new SkillCatalog({ trace: { kind: "memory", sessionId: "t" } });
    skillCatalog.register(deployWithSkillDep);
    skillCatalog.register(deckOutlining);
    const tool = searchCapabilitiesTool(new ToolCatalog(), skillCatalog);
    skillCatalog.drainTraceEvents();

    await tool.execute({ query: "deploy to vercel", maxDepth: 1 });
    const events = skillCatalog.drainTraceEvents() as Array<Record<string, unknown>>;
    // the registry's own skill_search for the query carries dep_count 0…
    const query = events.find((e) => e.type === "skill_search" && e.dep_count === 0);
    expect(query, "registry skill_search with dep_count 0").toBeTruthy();
    // …and the capability layer records a second one for the expansion.
    const expansion = events.find((e) => e.type === "skill_search" && (e.dep_count as number) > 0);
    expect(expansion?.dep_count).toBe(1);
    expect(expansion?.origin).toBe("agent");
    expect(expansion?.hits).toEqual([{ skill_id: "deck-outlining", score: 0 }]);

    // no expansion event at the default depth (nothing was pulled)
    await tool.execute({ query: "deploy to vercel" });
    const defaults = skillCatalog.drainTraceEvents() as Array<Record<string, unknown>>;
    expect(
      defaults.filter((e) => e.type === "skill_search" && (e.dep_count as number) > 0),
    ).toEqual([]);
  });

  it("clamps maxDepth: negative/fractional fall back to 0, huge values cap at 3", async () => {
    const tool = searchCapabilitiesTool(new ToolCatalog(), chainCatalog());
    const ids = async (maxDepth: number): Promise<string[]> => {
      const r = (await tool.execute({
        query: "deploy to vercel",
        maxDepth,
      })) as SearchCapabilitiesResult;
      return r.skills.map((s) => s.skillId);
    };
    expect(await ids(-1)).toEqual(["vercel-deploy"]);
    expect(await ids(1.5)).toEqual(["vercel-deploy"]);
    // 99 clamps to the cap of 3: chain-l4 sits at depth 4 and stays out
    expect(await ids(99)).toEqual(["vercel-deploy", "chain-l1", "chain-l2", "chain-l3"]);
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

  it("returns an error object (with isError) for unknown toolId", async () => {
    const tool = invokeToolTool(new ToolCatalog());
    const result = (await tool.execute({ toolId: "nope", args: {} })) as {
      error: string;
      isError?: boolean;
    };
    expect(result.error).toMatch(/unknown toolId: nope/);
    expect(result.isError).toBe(true);
  });

  it("rejects non-object args instead of forwarding stray top-level keys", async () => {
    const tools = new ToolCatalog();
    tools.register(readFile);
    const tool = invokeToolTool(tools);
    // `args` present but a string → reject, don't silently flatten.
    const result = (await tool.execute({ toolId: "fs__read_file", args: "oops", path: "/x" })) as {
      error: string;
      isError?: boolean;
    };
    expect(result.error).toMatch(/must be an object/);
    expect(result.isError).toBe(true);
  });

  it("treats explicit args: null as no args, not a stray `args` key", async () => {
    const tools = new ToolCatalog();
    // Echo tool returns exactly the args object it was invoked with.
    tools.register({
      id: "x__echo",
      name: "echo",
      description: "echoes its args",
      inputSchema: {},
      outputSchema: {},
      execute: async (a) => a,
    });
    const tool = invokeToolTool(tools);
    // explicit null → {} (no leftover `args` key), not { args: null }
    expect(await tool.execute({ toolId: "x__echo", args: null })).toEqual({});
    // a genuinely flattened call still passes its keys through (minus toolId/args)
    expect(await tool.execute({ toolId: "x__echo", foo: 1, args: null })).toEqual({ foo: 1 });
  });

  it("keeps invoke_tool guidance neutral about the discovery tool (compat-safe)", async () => {
    // invoke_tool is shared by the deprecated `search_tools` and the new
    // `search_capabilities`; naming either would misdirect the other deployment.
    const tool = invokeToolTool(new ToolCatalog());
    expect(tool.description).not.toContain("search_capabilities");
    const toolIdDesc = (tool.inputSchema as { properties: { toolId: { description: string } } })
      .properties.toolId.description;
    expect(toolIdDesc).not.toContain("search_capabilities");
    const result = (await tool.execute({ toolId: "nope", args: {} })) as { error: string };
    expect(result.error).not.toContain("search_capabilities");
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
      isError?: boolean;
      upstream?: string;
    };
    expect(result.error).toBe("needs_auth");
    // needs_auth is a failed call (the tool didn't run) — host promotes on isError.
    expect(result.isError).toBe(true);
    expect(result.upstream).toBe("stripe");
    expect(seen).toEqual(["stripe"]);
  });

  it("emits a ratel.auth.flow span (outcome=needs_auth, upstream) on the needs_auth path", async () => {
    const exporter = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
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
    const tool = invokeToolTool(tools);
    await tool.execute({ toolId: "stripe__charges", args: {} });

    const [span] = exporter.getFinishedSpans().filter((s) => s.name === "ratel.auth.flow");
    expect(span, "one ratel.auth.flow span").toBeTruthy();
    expect(span.attributes["ratel.auth.outcome"]).toBe("needs_auth");
    expect(span.attributes["ratel.upstream.server"]).toBe("stripe");
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
