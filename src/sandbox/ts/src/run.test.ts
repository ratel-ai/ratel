import { describe, expect, it } from "vitest";
import { CATALOG_HOST_KEY, type CatalogHost } from "./catalog.js";
import { runSandbox } from "./run.js";
import { defineSandbox, structured } from "./sandbox.js";
import { labelSandbox } from "./test-support/label.sandbox.js";

describe("runSandbox", () => {
  it("calls run with the input, the resolved params and a context", async () => {
    const r = await runSandbox(labelSandbox, {
      input: { workflowId: "wf", toolOrder: [] },
      overrides: { maxTokens: 100 },
    });
    expect(r.output).toEqual({
      name: "wf:claude-sonnet-5-5:100",
      system: "You name agent workflows.",
    });
    expect(r.overrides).toEqual(["maxTokens"]);
    expect(r.configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serves catalog overrides to the run's SDK reads and returns what it read", async () => {
    // Reads the global slot the way @ratel-ai/sdk/experimental/catalog does.
    const read = (kind: "prompt" | "model", id: string, fallback: string) => {
      const host = (globalThis as { [CATALOG_HOST_KEY]?: CatalogHost })[CATALOG_HOST_KEY];
      host?.record({ kind, id, default: fallback });
      return host?.resolve(kind, id) ?? fallback;
    };
    const catalogSandbox = defineSandbox("catalog", {
      params: {},
      input: structured<{ q: string }>({ type: "object" }),
      run: async () => ({
        system: read("prompt", "system", "d"),
        model: read("model", "answer", "a/b"),
      }),
    });
    const r = await runSandbox(catalogSandbox, {
      input: { q: "x" },
      catalogOverrides: { prompts: { system: "Overridden." }, models: {} },
    });
    expect(r.output).toEqual({ system: "Overridden.", model: "a/b" });
    expect(r.catalogReads).toEqual([
      { kind: "prompt", id: "system", default: "d" },
      { kind: "model", id: "answer", default: "a/b" },
    ]);
  });
});
