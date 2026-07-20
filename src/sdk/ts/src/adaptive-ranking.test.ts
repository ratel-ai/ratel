import { describe, expect, it } from "vitest";
import { IntentGraph, SkillCatalog, ToolCatalog } from "./index.js";

/**
 * A catalog where lexical retrieval is confidently wrong: "why is the build
 * broken" hits `docker_build` on the token *build*, while the tool people
 * actually reach for is `gh_run_list`.
 */
async function buildCatalog(): Promise<ToolCatalog> {
  const catalog = new ToolCatalog();
  await catalog.register([
    {
      id: "docker_build",
      name: "docker_build",
      description: "Build a Docker image from a Dockerfile",
      inputSchema: {},
      outputSchema: {},
      execute: async () => "built",
    },
    {
      id: "gh_run_list",
      name: "gh_run_list",
      description: "List CI workflow runs and whether the build passed",
      inputSchema: {},
      outputSchema: {},
      execute: async () => "listed",
    },
    {
      id: "read_file",
      name: "read_file",
      description: "Read a file from disk",
      inputSchema: {},
      outputSchema: {},
      execute: async () => "read",
    },
  ]);
  return catalog;
}

const ids = (hits: readonly { toolId: string }[]) => hits.map((h) => h.toolId);

/** One confirmed observation: search, then invoke what you actually wanted. */
async function useIt(catalog: ToolCatalog, query: string, chosen: string): Promise<void> {
  catalog.search(query, 5);
  await catalog.invoke(chosen, {});
}

describe("adaptive usage ranking", () => {
  it("leaves ranking untouched until it is enabled", async () => {
    const catalog = await buildCatalog();
    const hits = catalog.search("why is the build broken", 5);
    expect(hits[0]?.toolId).toBe("docker_build");
  });

  it("learns from use and then ranks better", async () => {
    const catalog = await buildCatalog();
    const graph = new IntentGraph();
    catalog.enableAdaptiveRanking(graph);

    expect(graph.clusterCount).toBe(0);

    await useIt(catalog, "why is the build broken", "gh_run_list");
    await useIt(catalog, "is the build broken again", "gh_run_list");
    await useIt(catalog, "the build broken on main", "gh_run_list");

    expect(graph.clusterCount).toBe(1);

    const order = ids(catalog.search("why is the build broken", 5));
    expect(order.indexOf("gh_run_list")).toBeLessThan(order.indexOf("docker_build"));
  });

  it("does not disturb a query it has no evidence about", async () => {
    const baseline = ids((await buildCatalog()).search("read a file from disk", 5));

    const catalog = await buildCatalog();
    catalog.enableAdaptiveRanking(new IntentGraph());
    await useIt(catalog, "why is the build broken", "gh_run_list");
    await useIt(catalog, "is the build broken again", "gh_run_list");
    await useIt(catalog, "the build broken on main", "gh_run_list");

    expect(ids(catalog.search("read a file from disk", 5))).toEqual(baseline);
  });

  it("carries what it learned across processes via the wire form", async () => {
    // The point of `toJson`/`fromJson`: the graph is in memory, so this is how a
    // restart keeps what previous runs discovered.
    const first = await buildCatalog();
    const graph = new IntentGraph();
    first.enableAdaptiveRanking(graph);
    await useIt(first, "why is the build broken", "gh_run_list");
    await useIt(first, "is the build broken again", "gh_run_list");
    await useIt(first, "the build broken on main", "gh_run_list");

    const restored = IntentGraph.fromJson(graph.toJson());
    expect(restored.clusterCount).toBe(1);

    const second = await buildCatalog();
    second.enableAdaptiveRanking(restored);
    const order = ids(second.search("why is the build broken", 5));
    expect(order.indexOf("gh_run_list")).toBeLessThan(order.indexOf("docker_build"));
  });

  it("rejects a graph from a schema version it does not read", () => {
    const future = JSON.stringify({
      v: 2,
      half_life_days: 30,
      built_from_ts: 1,
      intents: [],
    });
    expect(() => IntentGraph.fromJson(future)).toThrow(/version/i);
  });

  it("stops learning and ranking when disabled, keeping what it knows", async () => {
    const catalog = await buildCatalog();
    const graph = new IntentGraph();
    catalog.enableAdaptiveRanking(graph);
    await useIt(catalog, "why is the build broken", "gh_run_list");
    await useIt(catalog, "is the build broken again", "gh_run_list");
    await useIt(catalog, "the build broken on main", "gh_run_list");

    catalog.disableAdaptiveRanking();
    const order = ids(catalog.search("why is the build broken", 5));
    expect(order[0]).toBe("docker_build");

    await useIt(catalog, "the build broken elsewhere", "gh_run_list");
    expect(graph.clusterCount).toBe(1);
    expect(graph.toJson()).toContain("gh_run_list");
  });

  it("shares one graph between a tool catalog and a skill catalog", async () => {
    // One cluster, two edge maps — giving each catalog its own graph would
    // duplicate the cluster and split the evidence.
    const graph = new IntentGraph();
    const tools = await buildCatalog();
    const skills = new SkillCatalog();
    await skills.register([
      {
        id: "ci-triage",
        name: "ci-triage",
        description: "Diagnose why the build failed in CI",
        tags: [],
        tools: [],
        metadata: {},
        body: "# steps",
      },
    ]);
    tools.enableAdaptiveRanking(graph);
    skills.enableAdaptiveRanking(graph);

    await useIt(tools, "why is the build broken", "gh_run_list");
    skills.search("why is the build broken", 5);
    skills.invoke("ci-triage");

    expect(graph.clusterCount).toBe(1);
    const wire = JSON.parse(graph.toJson());
    expect(Object.keys(wire.intents[0].tools)).toContain("gh_run_list");
    expect(Object.keys(wire.intents[0].skills)).toContain("ci-triage");
  });
});
