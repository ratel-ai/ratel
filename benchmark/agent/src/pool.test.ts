import { describe, expect, it } from "vitest";
import { buildToolUniverse, expandPool } from "./pool.js";
import type { Scenario, ToolSpec } from "./types.js";

function spec(id: string): ToolSpec {
  return { id, name: id, description: `tool ${id}`, input_schema: {} };
}

function scenario(id: string, pool: ToolSpec[], gold: string[]): Scenario {
  return { id, prompt: `do ${id}`, candidate_pool: pool, gold_tools: gold };
}

describe("buildToolUniverse", () => {
  it("returns every distinct tool across all scenarios, deduped by id", () => {
    const u = buildToolUniverse([
      scenario("a", [spec("t1"), spec("t2")], ["t1"]),
      scenario("b", [spec("t2"), spec("t3")], ["t3"]),
    ]);
    expect(u.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("preserves first-seen tool spec on duplicate ids (deterministic dedup)", () => {
    const first: ToolSpec = { ...spec("t1"), description: "first" };
    const second: ToolSpec = { ...spec("t1"), description: "second" };
    const u = buildToolUniverse([scenario("a", [first], ["t1"]), scenario("b", [second], ["t1"])]);
    expect(u).toHaveLength(1);
    expect(u[0].description).toBe("first");
  });

  it("returns an empty array on empty input", () => {
    expect(buildToolUniverse([])).toEqual([]);
  });
});

describe("expandPool", () => {
  const universe: ToolSpec[] = Array.from({ length: 20 }, (_, i) => spec(`t${i}`));
  const s = scenario("scn-1", [spec("t0"), spec("t1")], ["t0", "t1"]);

  it("returns gold tools first, then distractors", () => {
    const out = expandPool(s, universe, 5, 42);
    expect(out.slice(0, 2).map((t) => t.id)).toEqual(["t0", "t1"]);
    expect(out).toHaveLength(5);
    // The 3 distractors must come from the universe minus the gold tools.
    const distractorIds = out.slice(2).map((t) => t.id);
    for (const id of distractorIds) {
      expect(["t0", "t1"]).not.toContain(id);
    }
  });

  it("is deterministic for the same (scenario.id, seed) pair", () => {
    const a = expandPool(s, universe, 10, 42);
    const b = expandPool(s, universe, 10, 42);
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
  });

  it("varies the distractor order across different scenario ids", () => {
    const s2 = { ...s, id: "scn-2" };
    const a = expandPool(s, universe, 20, 42);
    const b = expandPool(s2, universe, 20, 42);
    // Gold is at the head of both; distractor tail should differ.
    expect(a.slice(2).map((t) => t.id)).not.toEqual(b.slice(2).map((t) => t.id));
  });

  it("varies the distractor order across different seeds", () => {
    const a = expandPool(s, universe, 20, 1);
    const b = expandPool(s, universe, 20, 2);
    expect(a.slice(2).map((t) => t.id)).not.toEqual(b.slice(2).map((t) => t.id));
  });

  it("returns just the gold tools when targetSize ≤ gold.length", () => {
    expect(expandPool(s, universe, 2, 42).map((t) => t.id)).toEqual(["t0", "t1"]);
    // Smaller-than-gold targets still preserve all gold (selection requires it).
    expect(expandPool(s, universe, 1, 42).map((t) => t.id)).toEqual(["t0", "t1"]);
  });

  it("returns the full universe when targetSize exceeds it (no padding)", () => {
    const tiny: ToolSpec[] = [spec("t0"), spec("t1"), spec("t2")];
    const out = expandPool(s, tiny, 100, 42);
    expect(out).toHaveLength(3);
    expect(out.map((t) => t.id).sort()).toEqual(["t0", "t1", "t2"]);
  });

  it("includes gold tools that aren't in the universe (defensive: always present)", () => {
    const universeWithoutGold: ToolSpec[] = [spec("t5"), spec("t6"), spec("t7")];
    const out = expandPool(s, universeWithoutGold, 4, 42);
    // Both gold tools survive at the head even though they're not in universe.
    expect(out.slice(0, 2).map((t) => t.id)).toEqual(["t0", "t1"]);
    expect(out.length).toBe(4);
  });

  it("does not duplicate a gold tool that also appears in the universe", () => {
    const out = expandPool(s, universe, 20, 42);
    const ids = out.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
