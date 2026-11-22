import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATALOG_HOST_KEY, type CatalogHost, type RunSkill } from "./prompt-model-catalog.js";
import { SkillCatalog } from "./skill-catalog.js";
import { getSkillContentTool } from "./skill-tools.js";

// The run-scoped skill view: inside a sandbox run (an active catalog host with a
// `skill` view), the standard SkillCatalog boundaries read through it. Outside a run,
// nothing changes. The host here is a stub; the sandbox package serves the real one.

const slot = globalThis as { [CATALOG_HOST_KEY]?: CatalogHost };

const skills = [
  { id: "summarize_doc", name: "summarize_doc", description: "Summarize a docs page.", body: "B1" },
  { id: "escalate_bug", name: "escalate_bug", description: "Escalate a docs bug.", body: "B2" },
];

async function catalog(): Promise<SkillCatalog> {
  const c = new SkillCatalog();
  await c.register(skills);
  return c;
}

function host(view: Record<string, RunSkill | null>): CatalogHost {
  return {
    resolve: () => undefined,
    record: () => {},
    skill: (id) => (Object.hasOwn(view, id) ? view[id] : undefined),
  };
}

function runSkill(mode: RunSkill["mode"], load: RunSkill["load"], description?: string): RunSkill {
  return { mode, load, ...(description ? { description } : {}) };
}

afterEach(() => {
  delete slot[CATALOG_HOST_KEY];
});

describe("outside a sandbox run", () => {
  it("search, has, get, invoke and get_skill_content behave as before", async () => {
    const c = await catalog();
    expect(
      c
        .search("docs", 5)
        .map((h) => h.skillId)
        .sort(),
    ).toEqual(["escalate_bug", "summarize_doc"]);
    expect(c.has("escalate_bug")).toBe(true);
    expect(c.invoke("summarize_doc")).toBe("B1");
    await expect(c.invokeAsync("summarize_doc")).resolves.toBe("B1");
    expect(await getSkillContentTool(c).execute({ skillId: "summarize_doc" })).toEqual({
      body: "B1",
    });
  });
});

describe("inside a sandbox run", () => {
  it("leaves a disabled skill out of search and refuses it by id", async () => {
    const c = await catalog();
    slot[CATALOG_HOST_KEY] = host({ escalate_bug: null });
    expect(c.search("docs", 5).map((h) => h.skillId)).toEqual(["summarize_doc"]);
    expect((await c.searchAsync("docs", 5)).map((h) => h.skillId)).toEqual(["summarize_doc"]);
    expect(c.has("escalate_bug")).toBe(false);
    expect(c.get("escalate_bug")).toBeUndefined();
    expect(() => c.invoke("escalate_bug")).toThrow(/unknown skillId: escalate_bug/);
    expect(await getSkillContentTool(c).execute({ skillId: "escalate_bug" })).toMatchObject({
      isError: true,
    });
  });

  it("shows the edited description through get, without changing the catalog", async () => {
    const c = await catalog();
    slot[CATALOG_HOST_KEY] = host({
      summarize_doc: runSkill("real", async (read) => read(), "Edited."),
    });
    expect(c.get("summarize_doc")?.description).toBe("Edited.");
    delete slot[CATALOG_HOST_KEY];
    expect(c.get("summarize_doc")?.description).toBe("Summarize a docs page.");
  });

  it("returns a fake without reading the stored body", async () => {
    const c = await catalog();
    let bodyReads = 0;
    // A fake load answers from the fake source and never calls the body reader.
    const fake = runSkill("fake", async () => "FAKE");
    slot[CATALOG_HOST_KEY] = host({
      summarize_doc: {
        ...fake,
        load: (readBody) =>
          fake.load(() => {
            bodyReads++;
            return readBody();
          }),
      },
    });
    expect(await getSkillContentTool(c).execute({ skillId: "summarize_doc" })).toEqual({
      body: "FAKE",
    });
    expect(bodyReads).toBe(0);
    // The sync invoke cannot wait for a fake or a reviewer: it says to use the async path.
    expect(() => c.invoke("summarize_doc")).toThrow(/fake mode.*invokeAsync/);
  });

  it("returns the body on a confirm load the reviewer approves", async () => {
    const c = await catalog();
    slot[CATALOG_HOST_KEY] = host({ summarize_doc: runSkill("confirm", async (read) => read()) });
    expect(await getSkillContentTool(c).execute({ skillId: "summarize_doc" })).toEqual({
      body: "B1",
    });
  });

  it("returns the reviewer error when a confirm load is rejected", async () => {
    const c = await catalog();
    slot[CATALOG_HOST_KEY] = host({
      summarize_doc: runSkill("confirm", async () => {
        throw new Error("Rejected by reviewer");
      }),
    });
    expect(await getSkillContentTool(c).execute({ skillId: "summarize_doc" })).toEqual({
      error: "Rejected by reviewer",
      isError: true,
    });
  });
});

describe("the skill load span", () => {
  let exporter: InMemorySpanExporter;
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
  });
  afterEach(() => {
    trace.disable();
  });

  it("carries ratel.tool.mode in a run, and no mode outside one", async () => {
    const c = await catalog();
    await c.invokeAsync("summarize_doc");
    slot[CATALOG_HOST_KEY] = host({ summarize_doc: runSkill("fake", async () => "FAKE") });
    await c.invokeAsync("summarize_doc");
    const loads = exporter.getFinishedSpans().filter((s) => s.name === "ratel.skill.load");
    expect(loads.map((s) => s.attributes["ratel.tool.mode"])).toEqual([undefined, "fake"]);
  });
});
