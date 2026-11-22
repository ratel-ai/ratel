import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { type Ratel, ratel } from "@ratel-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withSdkParams } from "./auto-params.js";
import { captureSetup, REGISTRY_KEY } from "./catalog.js";
import { runSandbox } from "./run.js";
import { defineSandbox, type Sandbox, structured } from "./sandbox.js";
import { RATEL_TOOL_MODE, type ToolChannel } from "./tools.js";

// Skills registered on a real `ratel()` core, used through the standard SDK boundaries
// (SkillCatalog search, recall, and the search_capabilities / get_skill_content model
// tools) inside sandbox runs: the run's skill overrides apply there.

const summarizeDoc = {
  id: "summarizeDoc",
  name: "summarizeDoc",
  description: "Summarize one docs page.",
  body: "Read the page, then answer in three bullets.",
  annotations: { readOnlyHint: true },
};
const escalate = {
  id: "escalate",
  name: "escalate",
  description: "Escalate a docs question to a human.",
  body: "Collect the logs first.",
};

type Probe = (core: Ratel) => Promise<unknown>;

/** Loads an agent whose core registers the skills on import; run() runs `probe`. */
async function load(probe: Probe): Promise<{ agent: Sandbox; core: Ratel }> {
  let core: Ratel | undefined;
  const { result, capture } = await captureSetup(async () => {
    core = ratel();
    await core.skills.register([summarizeDoc, escalate]);
    return defineSandbox("agent", {
      input: structured<{ q: string }>({ type: "object" }),
      run: async () => probe(core as Ratel),
    });
  });
  return { agent: withSdkParams(result as Sandbox, capture), core: core as Ratel };
}

const getSkill = (core: Ratel, skillId: string) =>
  core.modelTools().get_skill_content?.execute({ skillId });
const search = async (core: Ratel) =>
  (await core.skills.searchAsync("docs", 5)).map((h) => h.skillId).sort();

function channel(decision: "approve" | "reject" = "approve"): ToolChannel {
  return {
    fake: async () => ({ result: "A pinned fake body.", isError: false, source: "pinned" }),
    confirm: async () => ({ decision }),
  };
}

const input = { q: "hi" };

beforeEach(() => {
  delete (globalThis as { [REGISTRY_KEY]?: unknown })[REGISTRY_KEY];
});

describe("a disabled skill", () => {
  it("is absent from standard search and refused by id", async () => {
    const { agent } = await load(async (core) => ({
      search: await search(core),
      has: core.skills.has("escalate"),
      load: await getSkill(core, "escalate"),
    }));
    const r = await runSandbox(agent, {
      input,
      overrides: { skills: [{ name: "summarizeDoc" }, { name: "escalate", enabled: false }] },
    });
    expect(r.output).toEqual({
      search: ["summarizeDoc"],
      has: false,
      load: expect.objectContaining({ isError: true, error: expect.stringMatching(/unknown/) }),
    });
  });
});

describe("an edited description", () => {
  it("is what search_capabilities and recall show", async () => {
    const { agent } = await load(async (core) => {
      const found = (await core
        .modelTools()
        .search_capabilities?.execute({ query: "summarize docs page" })) as {
        skills: { skillId: string; description: string }[];
      };
      const recalled = await core.recall("summarize docs page");
      return {
        found: found.skills.find((s) => s.skillId === "summarizeDoc")?.description,
        recalled: recalled?.skills.find((s) => s.skillId === "summarizeDoc")?.description,
      };
    });
    const r = await runSandbox(agent, {
      input,
      overrides: {
        skills: [
          { name: "summarizeDoc", description: "Edited: summarize docs." },
          { name: "escalate" },
        ],
      },
    });
    expect(r.output).toEqual({
      found: "Edited: summarize docs.",
      recalled: "Edited: summarize docs.",
    });
  });
});

describe("skill modes on get_skill_content", () => {
  it("returns the body for a real skill and the fake value in fake mode", async () => {
    const { agent } = await load(async (core) => getSkill(core, "summarizeDoc"));
    expect((await runSandbox(agent, { input })).output).toEqual({ body: summarizeDoc.body });
    const faked = await runSandbox(agent, {
      input,
      toolChannel: channel(),
      toolModes: { summarizeDoc: "fake" },
    });
    expect(faked.output).toEqual({ body: "A pinned fake body." });
  });

  it("honors a reviewer's approve and reject in confirm mode", async () => {
    const { agent } = await load(async (core) => getSkill(core, "escalate"));
    expect((await runSandbox(agent, { input, toolChannel: channel("approve") })).output).toEqual({
      body: escalate.body,
    });
    expect((await runSandbox(agent, { input, toolChannel: channel("reject") })).output).toEqual({
      error: "Rejected by reviewer",
      isError: true,
    });
  });
});

describe("isolation", () => {
  it("keeps two concurrent runs apart and never changes the shared catalog", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const { agent, core } = await load(async (c) => {
      await tick();
      return { search: await search(c), description: c.skills.get("summarizeDoc")?.description };
    });
    const [a, b] = await Promise.all([
      runSandbox(agent, {
        input,
        overrides: {
          skills: [{ name: "summarizeDoc", description: "Run A." }, { name: "escalate" }],
        },
      }),
      runSandbox(agent, {
        input,
        overrides: { skills: [{ name: "summarizeDoc" }, { name: "escalate", enabled: false }] },
      }),
    ]);
    expect(a.output).toEqual({ search: ["escalate", "summarizeDoc"], description: "Run A." });
    expect(b.output).toEqual({ search: ["summarizeDoc"], description: summarizeDoc.description });
    expect(core.skills.get("summarizeDoc")?.description).toBe(summarizeDoc.description);
    expect(await search(core)).toEqual(["escalate", "summarizeDoc"]);
  });
});

describe("the skill load span", () => {
  let provider: NodeTracerProvider | undefined;
  afterEach(async () => {
    await provider?.shutdown();
    trace.disable();
    context.disable();
  });

  it("carries ratel.tool.mode", async () => {
    const memory = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
    provider.register();
    const { agent } = await load(async (core) => getSkill(core, "summarizeDoc"));
    await runSandbox(agent, { input, toolChannel: channel(), toolModes: { summarizeDoc: "fake" } });
    const span = memory.getFinishedSpans().find((s) => s.name === "ratel.skill.load");
    expect(span?.attributes[RATEL_TOOL_MODE]).toBe("fake");
  });
});
