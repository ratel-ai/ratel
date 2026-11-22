import { describe, expect, it } from "vitest";
import { CATALOG_HOST_KEY, type CatalogHost, withCatalogRun } from "./catalog.js";

// The SDK side (`@ratel-ai/sdk/experimental/catalog`) reads the host from this global
// slot. This simulates its reads, so the sandbox package needs no SDK dependency.
function sdkRead(kind: "prompt" | "model", id: string, fallback: string): string {
  const host = (globalThis as { [CATALOG_HOST_KEY]?: CatalogHost })[CATALOG_HOST_KEY];
  host?.record({ kind, id, default: fallback });
  return host?.resolve(kind, id) ?? fallback;
}

describe("withCatalogRun", () => {
  it("uses the slot key the SDK reads", () => {
    expect(CATALOG_HOST_KEY).toBe(Symbol.for("ratel.catalog.host.v1"));
  });

  it("serves the run overrides and collects the reads of the run", async () => {
    const { result, reads } = await withCatalogRun(
      { prompts: { system: "Overridden." }, models: {} },
      async () => [sdkRead("prompt", "system", "d"), sdkRead("model", "answer", "anthropic/x")],
    );
    expect(result).toEqual(["Overridden.", "anthropic/x"]);
    expect(reads).toEqual([
      { kind: "prompt", id: "system", default: "d" },
      { kind: "model", id: "answer", default: "anthropic/x" },
    ]);
  });

  it("keeps concurrent runs apart", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const [a, b] = await Promise.all([
      withCatalogRun({ prompts: { system: "A" }, models: {} }, async () => {
        await tick();
        return sdkRead("prompt", "system", "d");
      }),
      withCatalogRun({ prompts: { system: "B" }, models: {} }, async () => {
        await tick();
        return sdkRead("prompt", "system", "d");
      }),
    ]);
    expect([a.result, b.result]).toEqual(["A", "B"]);
  });

  it("falls through outside a run", async () => {
    await withCatalogRun({ prompts: { system: "A" }, models: {} }, async () => undefined);
    expect(sdkRead("prompt", "system", "d")).toBe("d");
  });
});
