import { describe, expect, it, vi } from "vitest";
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

  it("tracks writes with a monotonic rev that survives the wire form", async () => {
    // `rev` is the primitive for the caller's storage layer: save only when it
    // changed, and detect a writer that moved past your base.
    const catalog = await buildCatalog();
    const graph = new IntentGraph();
    catalog.enableAdaptiveRanking(graph);
    expect(graph.rev).toBe(0);

    await useIt(catalog, "why is the build broken", "gh_run_list");
    const afterOne = graph.rev;
    expect(afterOne).toBeGreaterThan(0);

    await useIt(catalog, "is the build broken again", "gh_run_list");
    expect(graph.rev).toBeGreaterThan(afterOne);

    // The counter is carried across a save/restore, so it stays monotonic.
    expect(IntentGraph.fromJson(graph.toJson()).rev).toBe(graph.rev);
  });

  it("rejects a graph from a schema version it does not read", () => {
    const future = JSON.stringify({
      v: 2,

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

  it("exposes rank and fused so callers avoid the scale-shifting score", async () => {
    const catalog = await buildCatalog();
    const graph = new IntentGraph();
    catalog.enableAdaptiveRanking(graph);

    // No evidence yet: raw scores, unfused.
    const cold = catalog.search("why is the build broken", 5);
    expect(cold.map((h) => h.rank)).toEqual(cold.map((_, i) => i));
    expect(cold.every((h) => h.fused === false)).toBe(true);

    await useIt(catalog, "why is the build broken", "gh_run_list");
    await useIt(catalog, "is the build broken again", "gh_run_list");
    await useIt(catalog, "the build broken on main", "gh_run_list");

    // Matched now: fused RRF scores, rank still contiguous from 0.
    const warm = catalog.search("why is the build broken", 5);
    expect(warm[0]?.rank).toBe(0);
    expect(warm.every((h) => h.fused === true)).toBe(true);

    // An unrelated query on the same catalog stays unfused — the between-calls
    // switch `fused` exists to expose.
    expect(catalog.search("read a file from disk", 5).every((h) => !h.fused)).toBe(true);
  });
});

// ---- embedding-model change detection ---------------------------------------

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const hub =
  process.env.HF_HUB_CACHE ??
  join(process.env.HF_HOME ?? join(homedir(), ".cache", "huggingface"), "hub");
const bgeSmall = join(
  hub,
  "models--BAAI--bge-small-en-v1.5",
  "snapshots",
  "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
);
const hasModel =
  existsSync(join(bgeSmall, "config.json")) && existsSync(join(bgeSmall, "tokenizer.json"));

/** A graph carrying a 384-dim centroid stamped with a DIFFERENT model than the
 * catalog will use — the persisted-graph-after-model-swap scenario. */
function staleModelGraph(): IntentGraph {
  const centroid = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  return IntentGraph.fromJson(
    JSON.stringify({
      v: 1,
      built_from_ts: 1,
      model: "some-other-model",
      intents: [
        {
          id: "intent_0",
          label: "l",
          terms: [],
          members: ["why is the build broken"],
          centroid,
          support: 9,
          tools: { gh_run_list: 1.0 },
          skills: {},
        },
      ],
    }),
  );
}

describe.skipIf(!hasModel)("adaptive ranking model-change detection", () => {
  async function semanticCatalog(): Promise<ToolCatalog> {
    const catalog = new ToolCatalog({ method: "semantic" });
    await catalog.register([
      {
        id: "gh_run_list",
        name: "gh_run_list",
        description: "list CI runs",
        inputSchema: {},
        outputSchema: {},
        execute: async () => "ok",
      },
      {
        id: "docker_build",
        name: "docker_build",
        description: "build an image",
        inputSchema: {},
        outputSchema: {},
        execute: async () => "ok",
      },
    ]);
    return catalog;
  }

  it("pauses and warns on a model mismatch, and rebuild restores it", async () => {
    const catalog = await semanticCatalog();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      catalog.enableAdaptiveRanking(staleModelGraph());
      expect(catalog.adaptiveRankingStatus.status).toBe("paused: model mismatch");
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain("rebuildIntentGraph()");

      await catalog.rebuildIntentGraph();
      expect(catalog.adaptiveRankingStatus.status).toBe("active");
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent when warnOnModelMismatch is false", async () => {
    const catalog = await semanticCatalog();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      catalog.enableAdaptiveRanking(staleModelGraph(), { warnOnModelMismatch: false });
      expect(catalog.adaptiveRankingStatus.status).toBe("paused: model mismatch");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
