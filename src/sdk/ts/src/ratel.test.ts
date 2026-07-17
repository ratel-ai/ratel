import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import {
  type ExecutableTool,
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
      return { label: `adapted:${base.tools.catalog instanceof ToolCatalog}` };
    },
  };
}

const exec = (description: string): FakeTool => ({
  description,
  inputSchema: { type: "object" },
  execute: () => ({ ok: true }),
});

const native = (id: string, description: string): ExecutableTool => ({
  id,
  name: id,
  description,
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  execute: () => ({ ok: true }),
});

const CAPABILITY_IDS = [SEARCH_CAPABILITIES_ID, INVOKE_TOOL_ID, GET_SKILL_CONTENT_ID];

describe("ratel() standalone core", () => {
  it("r.tools is a chainable handle over the one shared catalog", () => {
    const r = ratel();
    const returned = r.tools.register(
      native("read_file", "Read a file from local disk."),
      native("write_file", "Write a file to local disk."),
    );
    expect(returned).toBe(r.tools); // chainable
    expect(r.tools.has("read_file")).toBe(true);
    expect(r.tools.get("write_file")?.description).toBe("Write a file to local disk.");
    expect(r.tools.search("read a file", 5)[0]?.toolId).toBe("read_file");
    expect(r.tools.catalog).toBeInstanceOf(ToolCatalog);
    expect(r.tools.catalog.has("read_file")).toBe(true); // same instance, no drift
    expect(r.skills).toBeInstanceOf(SkillCatalog);
  });

  it("invokes registered tools through the handle", async () => {
    const r = ratel();
    r.tools.register(native("ping", "Ping a host."));
    expect(await r.tools.invoke("ping", {})).toEqual({ ok: true });
  });

  it("native registration is authoritative: a duplicate id replaces in place", () => {
    const r = ratel();
    r.tools.register(native("dup", "first description"));
    r.tools.register(native("dup", "second description"));
    expect(r.tools.get("dup")?.description).toBe("second description"); // unlike the adapted path
  });

  it("expose() returns the three capability tools in native shape", async () => {
    const r = ratel();
    r.tools.register(native("read_file", "Read a file from local disk."));
    const out = r.expose();
    expect(Object.keys(out).sort()).toEqual([...CAPABILITY_IDS].sort());
    expect(out[SEARCH_CAPABILITIES_ID]?.id).toBe(SEARCH_CAPABILITIES_ID); // native, not adapted
    const result = (await out[SEARCH_CAPABILITIES_ID]?.execute({
      query: "read a file",
    })) as SearchCapabilitiesResult;
    expect(result.tools.groups[0]?.hits[0]?.toolId).toBe("read_file");
  });

  it("expose() always advertises get_skill_content, even with zero skills", async () => {
    const r = ratel();
    const out = r.expose();
    expect(Object.keys(out)).toContain(GET_SKILL_CONTENT_ID);
    // Empty skill catalog degrades to a structured error, never a missing tool.
    const res = (await out[GET_SKILL_CONTENT_ID]?.execute({ skillId: "nope" })) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
  });

  it("tools registered after expose() are discoverable through the exposed set", async () => {
    const r = ratel();
    const out = r.expose(); // expose first…
    r.tools.register(native("late_tool", "Deploy the app to production.")); // …register later
    const result = (await out[SEARCH_CAPABILITIES_ID]?.execute({
      query: "deploy production",
    })) as SearchCapabilitiesResult;
    expect(result.tools.groups[0]?.hits[0]?.toolId).toBe("late_tool");
  });

  it("loads a skill registered after expose() through the exposed get_skill_content", async () => {
    const r = ratel();
    const out = r.expose(); // taken once, before any skill exists
    r.skills.register({
      id: "deploy",
      name: "deploy",
      description: "Deploy playbook: preview vs production, rollbacks.",
      tags: [],
      body: "# Deploy",
    });
    const res = (await out[GET_SKILL_CONTENT_ID]?.execute({ skillId: "deploy" })) as {
      body?: string;
    };
    expect(res.body).toBe("# Deploy");
  });

  it("keeps the exposed search_capabilities description byte-stable across skill registration", () => {
    const r = ratel();
    const before = r.expose()[SEARCH_CAPABILITIES_ID]?.description;
    // The skills clause is always advertised — get_skill_content is always in
    // the set, so the description must never deny the bucket…
    expect(before).toContain("get_skill_content");
    r.skills.register({
      id: "deploy",
      name: "deploy",
      description: "Deploy playbook: preview vs production, rollbacks.",
      tags: [],
      body: "# Deploy",
    });
    // …and re-exposing after the first skill must not bust the prompt cache.
    expect(r.expose()[SEARCH_CAPABILITIES_ID]?.description).toBe(before);
  });

  it("throws when a tool shadows a reserved capability-tool id", () => {
    for (const id of CAPABILITY_IDS) {
      expect(() => ratel().tools.register(native(id, "impostor"))).toThrow(/reserved/);
    }
  });

  it("throws the actionable install-the-adapter error on framework-shaped tools", () => {
    const r = ratel();
    // A framework tool record: no id, zod-like schema, keyed externally.
    const zodLike = {
      description: "AI SDK style tool",
      inputSchema: { _def: {}, safeParse: () => ({}) },
      execute: () => ({}),
    };
    expect(() => r.tools.register(zodLike as unknown as ExecutableTool)).toThrow(/adaptTo/);
    // Dynamic (function) descriptions are a framework idiom too.
    const dynamicDescription = {
      ...native("x", "y"),
      description: () => "computed",
    };
    expect(() => r.tools.register(dynamicDescription as unknown as ExecutableTool)).toThrow(
      /adaptTo/,
    );
  });

  it("throws a plain TypeError, not the adapter hint, on non-object register input", () => {
    const r = ratel();
    expect(() => r.tools.register(null as unknown as ExecutableTool)).toThrow(
      /ExecutableTools; got object/,
    );
    expect(() => r.tools.register("read_file" as unknown as ExecutableTool)).toThrow(
      /ExecutableTools; got string/,
    );
  });

  it("throws its own error, not the adapter hint, on a native-shaped tool missing an id", () => {
    const r = ratel();
    // Plain native shape (string description, JSON-schema input) — just no id.
    // That's a malformed native tool, not a framework tool: the adapter hint
    // would send the caller off installing a package that can't help.
    const noId = {
      name: "orphan",
      description: "A plain native tool with a JSON schema but no id.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      execute: () => ({ ok: true }),
    };
    expect(() => r.tools.register(noId as unknown as ExecutableTool)).toThrow(
      /expects each ExecutableTool to have a string `id`/,
    );
    expect(() => r.tools.register(noId as unknown as ExecutableTool)).not.toThrow(/adaptTo/);
  });

  it("clamps tools.search topK the same as the funnel: caps at 50, falls back on invalid", () => {
    const r = ratel();
    const many = Array.from({ length: 60 }, (_, i) =>
      native(`grep_${i}`, `Search files variant ${i}: grep ripgrep.`),
    );
    r.tools.register(...many);
    // A stray-large topK is capped, not passed straight to the catalog.
    expect(r.tools.search("search files grep", 999).length).toBeLessThanOrEqual(50);
    // A negative topK falls back to the default 5 rather than wrapping to an
    // unbounded u32 set in the native layer.
    const negative = r.tools.search("search files grep", -1);
    expect(negative.length).toBeLessThanOrEqual(5);
    expect(negative.length).toBeGreaterThan(0);
  });

  it("recall() is a pure query: canonical result or null, no call ids", async () => {
    const r = ratel();
    expect(await r.recall("anything")).toBeNull(); // empty catalog

    r.tools.register(native("deploy_app", "Deploy the app to production."));
    expect(await r.recall("zzzqqq totally unrelated")).toBeNull(); // no hits

    const result = await r.recall("deploy to production");
    expect(result?.tools.groups[0]?.hits[0]?.toolId).toBe("deploy_app");
    expect(result).not.toHaveProperty("callId"); // pure shape, id-free
  });

  it("recall() includes the skills bucket when a skill is registered", async () => {
    const r = ratel();
    r.skills.register({
      id: "vercel-deploy",
      name: "vercel-deploy",
      description: "Deploy to Vercel: env vars, preview vs production, rollbacks.",
      tags: ["vercel"],
      body: "# Vercel",
    });
    expect((await r.recall("deploy to vercel"))?.skills.map((s) => s.skillId)).toContain(
      "vercel-deploy",
    );
  });

  it("caps recallTopK at 50 and falls back to the default on invalid values", async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      native(`grep_${i}`, `Search files variant ${i}: grep ripgrep.`),
    );

    const high = ratel({ recallTopK: 999 });
    high.tools.register(...many);
    const hi = (await high.recall("search files grep"))?.tools.groups.reduce(
      (n, g) => n + g.hits.length,
      0,
    );
    expect(hi).toBeLessThanOrEqual(50);
    expect(hi).toBeGreaterThan(5); // 999 honored past the default, capped at 50

    const low = ratel({ recallTopK: -1 });
    low.tools.register(...many);
    const lo = (await low.recall("search files grep"))?.tools.groups.reduce(
      (n, g) => n + g.hits.length,
      0,
    );
    expect(lo).toBeLessThanOrEqual(5); // invalid → default 5
  });

  it("derives server groups by the '__' prefix, treating a leading '__' as no prefix", async () => {
    const r = ratel();
    r.tools.register(
      native("github__create_issue", "Open a GitHub issue tracker ticket."),
      native("__weird_internal", "An internal GitHub issue tracker tool with leading underscores."),
    );
    const names = (await r.recall("github issue tracker"))?.tools.groups.map((g) => g.server.name);
    expect(names).toContain("github"); // sep > 0 → "github"
    expect(names).toContain("__weird_internal"); // sep === 0 → whole id
  });

  it("records a direct-origin gateway_search on recall", async () => {
    const r = ratel({ trace: { kind: "memory", sessionId: "t" } });
    r.tools.register(native("deploy_grep", "Deploy grep search tool."));
    r.tools.catalog.drainTraceEvents();
    await r.recall("deploy grep");
    const ev = (r.tools.catalog.drainTraceEvents() as Array<Record<string, unknown>>).find(
      (e) => e.type === "gateway_search",
    );
    expect(ev?.origin).toBe("direct");
  });
});

describe("ratel().adaptTo(adapter)", () => {
  it("merges the adapter's extend helpers onto the base surface", () => {
    const a = ratel().adaptTo(fakeAdapter());
    expect(a.label).toBe("adapted:true"); // TExt inferred and merged
    expect(typeof a.tools.register).toBe("function");
    expect(typeof a.expose).toBe("function");
    expect(typeof a.recall).toBe("function");
    expect(a.skills).toBeInstanceOf(SkillCatalog);
  });

  it("registers tools into the shared catalog; expose() returns only the capability set", () => {
    const a = ratel().adaptTo(fakeAdapter());
    const returned = a.tools.register({ read_file: exec("Read a file from local disk.") });
    expect(returned).toBe(a.tools); // chainable
    expect(a.tools.has("read_file")).toBe(true);
    expect(a.tools.catalog.has("read_file")).toBe(true); // same shared catalog
    expect(Object.keys(a.expose()).sort()).toEqual([...CAPABILITY_IDS].sort());
  });

  it("routes the capability tools through the adapter's expose codec", async () => {
    const a = ratel().adaptTo(fakeAdapter());
    a.tools.register({ read_file: exec("Read a file from local disk.") });
    const search = a.expose()[SEARCH_CAPABILITIES_ID];
    // A FakeTool has no id/outputSchema — a raw ExecutableTool would. Their
    // absence proves expose() ran the value through the codec, not shipped it raw.
    expect(search).not.toHaveProperty("id");
    expect(search).not.toHaveProperty("outputSchema");
    const result = (await search?.execute?.({ query: "read a file" })) as SearchCapabilitiesResult;
    expect(result.tools.groups[0]?.hits[0]?.toolId).toBe("read_file");
  });

  it("always advertises get_skill_content, even before any skill is registered", () => {
    const a = ratel().adaptTo(fakeAdapter());
    expect(Object.keys(a.expose())).toContain(GET_SKILL_CONTENT_ID);
  });

  it("tools registered after expose() are discoverable through the exposed set", async () => {
    const a = ratel().adaptTo(fakeAdapter());
    const out = a.expose();
    a.tools.register({ late_tool: exec("Deploy the app to production.") });
    const result = (await out[SEARCH_CAPABILITIES_ID]?.execute?.({
      query: "deploy production",
    })) as SearchCapabilitiesResult;
    expect(result.tools.groups[0]?.hits[0]?.toolId).toBe("late_tool");
  });

  it("keeps non-executable tools as per-view passthroughs, unregistered", () => {
    const core = ratel();
    const a = core.adaptTo(fakeAdapter());
    const b = core.adaptTo(fakeAdapter());
    const provider: FakeTool = { description: "provider-run search", inputSchema: {} };
    a.tools.register({ provider_search: provider });
    expect(a.expose().provider_search).toBe(provider); // eagerly exposed, untouched
    expect(a.tools.catalog.has("provider_search")).toBe(false); // never in the catalog
    expect(a.tools.has("provider_search")).toBe(true); // …but the view knows it
    expect(b.expose()).not.toHaveProperty("provider_search"); // framework-shaped → per view
  });

  it("exposes get/search/invoke on the adapted handle, at parity with the native ToolCollection", async () => {
    const a = ratel().adaptTo(fakeAdapter());
    a.tools.register({ read_file: exec("Read a file from local disk.") });
    expect(a.tools.get("read_file")?.description).toBe("Read a file from local disk.");
    expect(a.tools.search("read a file", 5)[0]?.toolId).toBe("read_file");
    expect(await a.tools.invoke("read_file", {})).toEqual({ ok: true });
  });

  it("adapted get/search/invoke are catalog-only: a passthrough is known to has() but not to them", () => {
    const a = ratel().adaptTo(fakeAdapter());
    const provider: FakeTool = { description: "provider-run search", inputSchema: {} };
    a.tools.register({ provider_search: provider });
    expect(a.tools.has("provider_search")).toBe(true); // the view knows it
    expect(a.tools.get("provider_search")).toBeUndefined(); // …but it's not in the catalog
  });

  it("throws when an app tool shadows a reserved capability-tool id", () => {
    for (const id of CAPABILITY_IDS) {
      const a = ratel().adaptTo(fakeAdapter());
      expect(() => a.tools.register({ [id]: exec("x") })).toThrow(/reserved/);
    }
  });

  it("skips ingest entirely for an id that is already registered", () => {
    const core = ratel();
    core.tools.register(native("shared_tool", "Shared grep tool."));
    let ingestCalls = 0;
    const counting: RatelAdapter<FakeTool, FakeMessage> = {
      ...fakeAdapter(),
      ingest(id, tool) {
        ingestCalls++;
        return fakeAdapter().ingest(id, tool);
      },
    };
    const a = core.adaptTo(counting);
    a.tools.register({ shared_tool: exec("would shadow") }); // native id → first-wins pre-check
    expect(ingestCalls).toBe(0);
    a.tools.register({ fresh: exec("Fresh tool.") });
    a.tools.register({ fresh: exec("Duplicate call.") });
    expect(ingestCalls).toBe(1); // ingest's user code must not re-run per repeated register
  });

  it("preserves an ingest-provided outputSchema and defaults an omitted one", () => {
    const withOutput: RatelAdapter<FakeTool, FakeMessage> = {
      ...fakeAdapter(),
      ingest(_id, tool) {
        return {
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
          execute: tool.execute ?? (() => ({})),
        };
      },
    };
    const a = ratel().adaptTo(withOutput);
    a.tools.register({ typed: exec("Tool with a declared output shape.") });
    expect(a.tools.catalog.get("typed")?.outputSchema).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });

    const b = ratel().adaptTo(fakeAdapter()); // fakeAdapter's ingest omits outputSchema
    b.tools.register({ untyped: exec("Tool without an output shape.") });
    expect(b.tools.catalog.get("untyped")?.outputSchema).toEqual({ type: "object" });
  });

  it("first registration of an id wins, across executables and passthroughs", () => {
    const a = ratel().adaptTo(fakeAdapter());
    a.tools.register({ dup: exec("first description") });
    a.tools.register({ dup: exec("second description") });
    expect(a.tools.catalog.get("dup")?.description).toBe("first description");

    // A passthrough claims its id too: a later executable must not shadow it.
    const provider: FakeTool = { description: "provider-run", inputSchema: {} };
    a.tools.register({ claimed: provider });
    a.tools.register({ claimed: exec("late executable") });
    expect(a.tools.catalog.has("claimed")).toBe(false);
    expect(a.expose().claimed).toBe(provider);
  });

  it("recall returns the adapter's message pair with a private-counter call id", async () => {
    const a = ratel().adaptTo(fakeAdapter());
    a.tools.register({ deploy_app: exec("Deploy the app to production servers.") });

    const first = await a.recall("deploy to production");
    expect(first).toHaveLength(2);
    expect(first[0].callId).toBe("recall_0");
    expect(first[0].body).toEqual({ query: "deploy to production" }); // ref carries the query
    expect(first[1].callId).toBe("recall_0");
    const recall = first[1].body as SearchCapabilitiesResult;
    expect(recall.tools.groups.length).toBeGreaterThan(0);

    const second = await a.recall("deploy to production");
    expect(second[0].callId).toBe("recall_1"); // monotonic private counter
  });

  it("recall returns [] and spends no call id when nothing matches", async () => {
    const a = ratel().adaptTo(fakeAdapter());
    expect(await a.recall("anything at all")).toEqual([]); // empty catalog, no skills

    a.tools.register({ deploy_app: exec("Deploy the app to production.") });
    // A query that shares no terms with the only tool → no hits → still [].
    expect(await a.recall("zzzqqq totally unrelated")).toEqual([]);
    // The counter was never spent, so the next real hit is still recall_0.
    expect(((await a.recall("deploy production")) as FakeMessage[])[0].callId).toBe("recall_0");
  });

  it("shares one core's catalog and recall counter across adapter views", async () => {
    const core = ratel();
    const a = core.adaptTo(fakeAdapter());
    const b = core.adaptTo(fakeAdapter());
    a.tools.register({ shared_tool: exec("Shared search grep tool.") });
    expect(b.tools.has("shared_tool")).toBe(true); // one catalog
    expect(core.tools.has("shared_tool")).toBe(true); // …the core's own

    expect(((await a.recall("shared grep")) as FakeMessage[])[0].callId).toBe("recall_0");
    expect(((await b.recall("shared grep")) as FakeMessage[])[0].callId).toBe("recall_1"); // shared counter
  });

  it("recall carries a skills-only match: the pair is built even with zero tool hits", async () => {
    const a = ratel().adaptTo(fakeAdapter());
    a.skills.register({
      id: "vercel-deploy",
      name: "vercel-deploy",
      description: "Deploy to Vercel: env vars, preview vs production, rollbacks.",
      tags: ["vercel"],
      body: "# Vercel",
    });
    const msgs = await a.recall("deploy to vercel");
    expect(msgs).toHaveLength(2);
    const recall = msgs[1].body as SearchCapabilitiesResult;
    expect(recall.tools.groups).toEqual([]);
    expect(recall.skills.map((s) => s.skillId)).toContain("vercel-deploy");
  });

  it("tolerates an extend returning a non-object: the view is still the usable base", () => {
    const bad = {
      ...fakeAdapter(),
      extend: () => 42,
    } as unknown as RatelAdapter<FakeTool, FakeMessage>;
    const a = ratel().adaptTo(bad);
    a.tools.register({ read_file: exec("Read a file from local disk.") });
    expect(Object.keys(a.expose()).sort()).toEqual([...CAPABILITY_IDS].sort());
  });

  it("validates the adapter shape, naming it via adapter.name", () => {
    expect(() => ratel().adaptTo({} as unknown as RatelAdapter)).toThrow(/RatelAdapter/);
    expect(() => ratel().adaptTo({ name: "broken" } as unknown as RatelAdapter)).toThrow(/broken/);
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
