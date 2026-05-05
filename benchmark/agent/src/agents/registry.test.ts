// Auto-discovery of `agents/non-control/*.ts`. Verifies the rules the
// folder layout depends on: every committed non-control file shows up,
// helper-prefixed (`_*.ts`) and test files (`*.test.ts`) are excluded, and
// the descriptors satisfy the contract.
//
// Locally-added arms (filenames starting with `ignore.`) are gitignored but
// still on disk, so they show up here too. Tests must therefore not assert
// against the *exact* size of the registry — only against minimum invariants
// that hold whether or not local arms are present.

import { describe, expect, it } from "vitest";
import { loadAgentRegistry } from "../runner.js";

const COMMITTED_NON_CONTROL = ["ratel-full", "ratel-pre-discovery", "ratel-discovery-tool"];

describe("loadAgentRegistry", () => {
  it("statically registers both control arms", async () => {
    const registry = await loadAgentRegistry();
    expect(registry.has("control-baseline")).toBe(true);
    expect(registry.has("control-oracle")).toBe(true);
    expect(registry.get("control-baseline")?.label).toBe("control (baseline)");
    expect(registry.get("control-oracle")?.label).toBe("control (oracle)");
  });

  it("auto-discovers every committed non-control agent file", async () => {
    const registry = await loadAgentRegistry();
    for (const id of COMMITTED_NON_CONTROL) {
      expect(registry.has(id), `expected registry to contain "${id}"`).toBe(true);
      const desc = registry.get(id);
      expect(desc?.id).toBe(id);
      expect(typeof desc?.run).toBe("function");
      expect(typeof desc?.label).toBe("string");
      expect(desc?.label.length).toBeGreaterThan(0);
    }
  });

  it("never picks up the shared-helpers file (filenames starting with `_`)", async () => {
    const registry = await loadAgentRegistry();
    for (const id of registry.keys()) {
      expect(id.startsWith("_")).toBe(false);
    }
  });

  it("descriptors expose stable id ↔ label pairs (label is human, id is the JSONL key)", async () => {
    const registry = await loadAgentRegistry();
    // ids are kebab-case, labels are human-readable.
    for (const [id, desc] of registry) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(desc.id).toBe(id);
    }
  });

  it("the claude-sdk arm (when locally present) declines non-Claude models", async () => {
    const registry = await loadAgentRegistry();
    const claudeSdk = registry.get("claude-sdk-tool-search");
    if (!claudeSdk) return; // local-only file may not be present in CI / clean clones
    expect(claudeSdk.skipForModel?.("gpt-5.4-mini")).toBe(true);
    expect(claudeSdk.skipForModel?.("ollama:qwen3.5")).toBe(true);
    expect(claudeSdk.skipForModel?.("claude-sonnet-4-6")).toBe(false);
  });
});
