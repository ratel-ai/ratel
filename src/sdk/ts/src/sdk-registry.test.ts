import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATALOG_HOST_KEY, type CatalogHost, ratel as catalog } from "./prompt-model-catalog.js";
import { ratel } from "./ratel.js";
import { REGISTRY_KEY, type SdkRegistry } from "./sdk-registry.js";
import { referenceAdapter } from "./testkit/reference-adapter.js";

const slot = globalThis as { [REGISTRY_KEY]?: SdkRegistry; [CATALOG_HOST_KEY]?: CatalogHost };

beforeEach(() => {
  delete slot[REGISTRY_KEY];
});

afterEach(() => {
  delete slot[CATALOG_HOST_KEY];
});

describe("process registry of SDK registrations", () => {
  it("uses the slot key the sandbox reads", () => {
    expect(REGISTRY_KEY).toBe(Symbol.for("ratel.registry.v1"));
  });

  it("records native tools and skills", async () => {
    const r = ratel();
    const tool = {
      id: "deploy",
      name: "deploy",
      description: "Deploy an application.",
      inputSchema: { type: "object" as const },
      outputSchema: { type: "object" as const },
      execute: () => ({ ok: true }),
    };
    await r.tools.register(tool);
    await r.skills.register({ id: "triage", name: "triage", description: "Triage a bug." });
    const registry = slot[REGISTRY_KEY];
    expect(registry?.tools).toEqual([
      {
        id: "deploy",
        description: "Deploy an application.",
        inputSchema: { type: "object" },
        tool,
      },
    ]);
    expect(registry?.skills).toEqual([
      {
        id: "triage",
        description: "Triage a bug.",
        skill: { id: "triage", name: "triage", description: "Triage a bug." },
      },
    ]);
  });

  it("records the framework tool of an adapted registration, passthroughs included", async () => {
    const r = ratel().adaptTo(referenceAdapter());
    const search = { description: "Search docs.", inputSchema: {}, execute: () => [] };
    const hosted = { description: "Provider search.", inputSchema: {} };
    await r.tools.register({ search, hosted });
    expect(slot[REGISTRY_KEY]?.tools.map((t) => [t.id, t.description, t.tool])).toEqual([
      ["search", "Search docs.", search],
      ["hosted", "Provider search.", hosted],
    ]);
  });

  it("records each prompt and model read once, with its first default", () => {
    catalog.prompt("system", "a");
    catalog.prompt("system", "b");
    catalog.model("answer", "anthropic/x");
    expect(slot[REGISTRY_KEY]?.reads).toEqual([
      { kind: "prompt", id: "system", default: "a" },
      { kind: "model", id: "answer", default: "anthropic/x" },
    ]);
  });
});

describe("ratel.toolset", () => {
  it("returns the toolset unchanged outside a sandbox run", () => {
    const tools = { a: { description: "a" } };
    expect(catalog.toolset(tools)).toBe(tools);
  });

  it("returns the toolset the active sandbox run serves", () => {
    const tools = { a: { description: "a" }, b: { description: "b" } };
    slot[CATALOG_HOST_KEY] = {
      resolve: () => undefined,
      record: () => {},
      toolset: <T>(t: T) => ({ a: (t as typeof tools).a }) as T,
    };
    expect(Object.keys(catalog.toolset(tools))).toEqual(["a"]);
  });
});

describe("ratel.skills", () => {
  const skills = [
    { id: "summarizeDoc", description: "Summarize a page.", body: "Read it, then summarize." },
    { id: "triage", description: "Triage a bug.", body: "Ask for logs." },
  ];

  it("returns every skill with its description and a load of its body outside a run", async () => {
    const view = catalog.skills(skills);
    expect(view.map((s) => [s.id, s.description])).toEqual([
      ["summarizeDoc", "Summarize a page."],
      ["triage", "Triage a bug."],
    ]);
    expect(await view[0]?.load()).toBe("Read it, then summarize.");
  });

  it("returns the view the active sandbox run serves", async () => {
    slot[CATALOG_HOST_KEY] = {
      resolve: () => undefined,
      record: () => {},
      skills: (list) =>
        list.slice(0, 1).map((s) => ({ ...s, description: "Edited.", load: async () => "faked" })),
    };
    const view = catalog.skills(skills);
    expect(view.map((s) => [s.id, s.description])).toEqual([["summarizeDoc", "Edited."]]);
    expect(await view[0]?.load()).toBe("faked");
  });
});
