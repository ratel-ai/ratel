import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import {
  GET_SKILL_CONTENT_ID,
  INVOKE_TOOL_ID,
  type RatelAdapter,
  ratel,
  SEARCH_CAPABILITIES_ID,
  type SearchCapabilitiesResult,
  SkillCatalog,
  ToolCatalog,
} from "./index.js";
import { unadaptedError } from "./ratel.js";

// A tiny in-repo adapter standing in for a real framework package: its tool type
// carries its own shape and its message type is observable, so tests can assert
// the core drove ingest/expose/recallMessages correctly without any framework.
interface FakeTool {
  description: string;
  inputSchema: JSONSchema7;
  execute?: (input: unknown) => unknown;
}
interface FakeMessage {
  role: "call" | "result";
  callId: string;
  body: unknown;
}
interface FakeExt {
  label: string;
}

function fakeAdapter(): RatelAdapter<FakeTool, FakeMessage, FakeExt> {
  return {
    name: "fake",
    ingest(_id, tool) {
      if (!tool.execute) return "passthrough";
      return {
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: tool.execute,
      };
    },
    expose(tool) {
      return {
        description: tool.description,
        inputSchema: tool.inputSchema as JSONSchema7,
        execute: (input) => tool.execute?.(input),
      };
    },
    recallMessages(ref, recall) {
      return [
        { role: "call", callId: ref.callId, body: { query: ref.query } },
        { role: "result", callId: ref.callId, body: recall },
      ];
    },
    extend(base) {
      return { label: `adapted:${base.catalog instanceof ToolCatalog}` };
    },
  };
}

const exec = (description: string): FakeTool => ({
  description,
  inputSchema: { type: "object" },
  execute: () => ({ ok: true }),
});

describe("ratel().adaptTo(adapter)", () => {
  it("merges the adapter's extend helpers onto the base surface", () => {
    const r = ratel().adaptTo(fakeAdapter());
    expect(r.label).toBe("adapted:true"); // TExt inferred and merged
    expect(typeof r.tools).toBe("function");
    expect(typeof r.recall).toBe("function");
    expect(r.catalog).toBeInstanceOf(ToolCatalog);
    expect(r.skills).toBeInstanceOf(SkillCatalog);
  });

  it("registers executable tools behind a stable gateway set, hiding them from the returned tools", () => {
    const r = ratel().adaptTo(fakeAdapter());
    const out = r.tools({ read_file: exec("Read a file from local disk.") });
    // The app tool goes into the catalog, not the returned set — that's the point.
    expect(r.catalog.has("read_file")).toBe(true);
    expect(Object.keys(out).sort()).toEqual([INVOKE_TOOL_ID, SEARCH_CAPABILITIES_ID].sort());
  });

  it("routes the gateway capability tools through the adapter's expose codec", async () => {
    const r = ratel().adaptTo(fakeAdapter());
    r.tools({ read_file: exec("Read a file from local disk.") });
    const search = r.tools({})[SEARCH_CAPABILITIES_ID];
    // A FakeTool has no id/outputSchema — a raw ExecutableTool would. Their
    // absence proves tools() ran the value through expose, not shipped it raw.
    expect(search).not.toHaveProperty("id");
    expect(search).not.toHaveProperty("outputSchema");
    expect(typeof search.execute).toBe("function");
    // …and expose wired execute to the real capability tool.
    const result = (await search.execute?.({ query: "read a file" })) as SearchCapabilitiesResult;
    expect(result.tools.groups[0]?.hits[0]?.toolId).toBe("read_file");
  });

  it("keeps non-executable tools as passthroughs, unregistered", () => {
    const r = ratel().adaptTo(fakeAdapter());
    const provider: FakeTool = { description: "provider-run search", inputSchema: {} };
    const out = r.tools({ provider_search: provider });
    expect(out.provider_search).toBe(provider); // eagerly exposed, untouched
    expect(r.catalog.has("provider_search")).toBe(false);
  });

  it("throws when an app tool shadows a reserved gateway id", () => {
    for (const id of [SEARCH_CAPABILITIES_ID, INVOKE_TOOL_ID, GET_SKILL_CONTENT_ID]) {
      const r = ratel().adaptTo(fakeAdapter());
      expect(() => r.tools({ [id]: exec("x") })).toThrow(/reserved/);
    }
  });

  it("first registration of an id wins", () => {
    const r = ratel().adaptTo(fakeAdapter());
    r.tools({ dup: exec("first description") });
    r.tools({ dup: exec("second description") });
    expect(r.catalog.get("dup")?.description).toBe("first description");
  });

  it("advertises get_skill_content in the gateway set only when a skill is registered", () => {
    const r = ratel().adaptTo(fakeAdapter());
    expect(Object.keys(r.tools({}))).not.toContain(GET_SKILL_CONTENT_ID);

    r.skills.register({
      id: "deploy",
      name: "deploy",
      description: "Deploy playbook: preview vs production, rollbacks.",
      tags: [],
      body: "# Deploy",
    });
    expect(Object.keys(r.tools({}))).toContain(GET_SKILL_CONTENT_ID);
  });

  it("recall returns the adapter's message pair with a private-counter call id", () => {
    const r = ratel().adaptTo(fakeAdapter());
    r.tools({ deploy_app: exec("Deploy the app to production servers.") });

    const first = r.recall("deploy to production");
    expect(first).toHaveLength(2);
    expect(first[0].callId).toBe("recall_0");
    expect(first[1].callId).toBe("recall_0");
    const recall = first[1].body as SearchCapabilitiesResult;
    expect(recall.tools.groups.length).toBeGreaterThan(0);

    const second = r.recall("deploy to production");
    expect(second[0].callId).toBe("recall_1"); // monotonic private counter
  });

  it("recall returns [] and spends no call id when nothing matches", () => {
    const r = ratel().adaptTo(fakeAdapter());
    expect(r.recall("anything at all")).toEqual([]); // empty catalog, no skills

    r.tools({ deploy_app: exec("Deploy the app to production.") });
    // A query that shares no terms with the only tool → no hits → still [].
    expect(r.recall("zzzqqq totally unrelated")).toEqual([]);
    // The counter was never spent, so the next real hit is still recall_0.
    expect((r.recall("deploy production") as FakeMessage[])[0].callId).toBe("recall_0");
  });

  it("recall includes the skills bucket when a skill is registered", () => {
    const r = ratel().adaptTo(fakeAdapter());
    r.skills.register({
      id: "vercel-deploy",
      name: "vercel-deploy",
      description: "Deploy to Vercel: env vars, preview vs production, rollbacks.",
      tags: ["vercel"],
      body: "# Vercel",
    });
    const msgs = r.recall("deploy to vercel");
    const recall = msgs[1].body as SearchCapabilitiesResult;
    expect(recall.skills.map((s) => s.skillId)).toContain("vercel-deploy");
  });

  it("clamps recallTopK to [1, 50]", () => {
    const many: Record<string, FakeTool> = {};
    for (let i = 0; i < 60; i++)
      many[`grep_${i}`] = exec(`Search files variant ${i}: grep ripgrep.`);

    const high = ratel({ recallTopK: 999 }).adaptTo(fakeAdapter());
    high.tools(many);
    const hi = (
      high.recall("search files grep")[1].body as SearchCapabilitiesResult
    ).tools.groups.reduce((n, g) => n + g.hits.length, 0);
    expect(hi).toBeLessThanOrEqual(50);
    expect(hi).toBeGreaterThan(5); // 999 honored past the default, capped at 50

    const low = ratel({ recallTopK: -1 }).adaptTo(fakeAdapter());
    low.tools(many);
    const lo = (
      low.recall("search files grep")[1].body as SearchCapabilitiesResult
    ).tools.groups.reduce((n, g) => n + g.hits.length, 0);
    expect(lo).toBeLessThanOrEqual(5); // invalid → default 5
  });

  it("derives server groups by the '__' prefix, treating a leading '__' as no prefix", () => {
    const r = ratel().adaptTo(fakeAdapter());
    r.tools({
      github__create_issue: exec("Open a GitHub issue tracker ticket."),
      __weird_internal: exec("An internal GitHub issue tracker tool with leading underscores."),
    });
    const groups = (r.recall("github issue tracker")[1].body as SearchCapabilitiesResult).tools
      .groups;
    const names = groups.map((g) => g.server.name);
    expect(names).toContain("github"); // sep > 0 → "github"
    expect(names).toContain("__weird_internal"); // sep === 0 → whole id
  });

  it("records a direct-origin gateway_search on recall", () => {
    const r = ratel({ trace: { kind: "memory", sessionId: "t" } }).adaptTo(fakeAdapter());
    r.tools({ deploy_grep: exec("Deploy grep search tool.") });
    r.catalog.drainTraceEvents();
    r.recall("deploy grep");
    const ev = (r.catalog.drainTraceEvents() as Array<Record<string, unknown>>).find(
      (e) => e.type === "gateway_search",
    );
    expect(ev?.origin).toBe("direct");
  });

  it("shares one core's catalog and recall counter across adapter views", () => {
    const core = ratel();
    const a = core.adaptTo(fakeAdapter());
    const b = core.adaptTo(fakeAdapter());
    a.tools({ shared_tool: exec("Shared search grep tool.") });
    expect(b.catalog.has("shared_tool")).toBe(true); // one catalog

    expect((a.recall("shared grep") as FakeMessage[])[0].callId).toBe("recall_0");
    expect((b.recall("shared grep") as FakeMessage[])[0].callId).toBe("recall_1"); // shared counter
  });

  it("validates the adapter shape, naming it via adapter.name", () => {
    expect(() => ratel().adaptTo({} as unknown as RatelAdapter)).toThrow(/RatelAdapter/);
    expect(() => ratel().adaptTo({ name: "broken" } as unknown as RatelAdapter)).toThrow(/broken/);
  });
});

describe("un-adapted ratel() core", () => {
  it("throws an actionable adapt-first error on framework-shaped use", () => {
    const core = ratel();
    expect(() => core.tools()).toThrow(/adaptTo/);
    expect(() => core.recall("x")).toThrow(/adaptTo/);
  });

  it("keeps the framework-free escape hatches available", () => {
    const core = ratel();
    expect(core.catalog).toBeInstanceOf(ToolCatalog);
    expect(core.skills).toBeInstanceOf(SkillCatalog);
  });
});

describe("unadaptedError", () => {
  it("names the exact adapter package when a known framework is detected", () => {
    const aiErr = unadaptedError((pkg) => pkg === "ai");
    expect(aiErr.message).toContain("@ratel-ai/ai-sdk-adapter");
    expect(aiErr.message).toContain("aiSdk");

    const mastraErr = unadaptedError((pkg) => pkg === "@mastra/core");
    expect(mastraErr.message).toContain("@ratel-ai/mastra-adapter");
    expect(mastraErr.message).toContain("mastra");
  });

  it("falls back to a generic adapt-first message when no framework is present", () => {
    const err = unadaptedError(() => false);
    expect(err.message).toContain("adaptTo");
    expect(err.message).not.toContain("Detected");
  });
});
