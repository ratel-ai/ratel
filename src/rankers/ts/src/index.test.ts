import * as sdk from "@ratel-ai/sdk";
import { describe, expect, it } from "vitest";
import { ChoiceRanker, vendors } from "../native/index.cjs";
import { nativeRanker } from "./adapter.js";
import {
  choiceRankerPlugin,
  definePlugin,
  type ChoiceRanker as Ranker,
  RetrieverError,
} from "./index.js";

describe("the plugin contract", () => {
  it("is the SDK's own, so a catalog's instanceof check sees plugin errors", () => {
    expect(RetrieverError).toBe(sdk.RetrieverError);
    expect(definePlugin).toBe(sdk.definePlugin);
  });
});

describe("choiceRankerPlugin", () => {
  it("wraps any ranker object into retrieve and rerank", async () => {
    const calls: { kind: string; ids: string[] }[] = [];
    const ranker: Ranker = {
      rankAsync: async (_query, candidates, _topK, kind) => {
        calls.push({ kind, ids: candidates.map((c) => c.id) });
        return candidates.map(({ id }, i) => ({ id, score: 1 - i / 10 }));
      },
    };
    const plugin = choiceRankerPlugin(ranker);
    expect(plugin.retrieve).toBe(plugin.rerank);
    const ranked = await plugin.rerank(
      "q",
      [
        { id: "a", kind: "skill", text: "A" },
        { id: "b", kind: "skill", text: "B" },
      ],
      2,
    );
    expect(ranked).toEqual([
      { id: "a", score: 1 },
      { id: "b", score: 0.9 },
    ]);
    expect(calls).toEqual([{ kind: "skill", ids: ["a", "b"] }]);
  });

  it("asks nothing for no candidates or topK 0", async () => {
    const ranker: Ranker = {
      rankAsync: async () => {
        throw new Error("not called");
      },
    };
    const { retrieve } = choiceRankerPlugin(ranker);
    expect(await retrieve("q", [], 5)).toEqual([]);
    expect(await retrieve("q", [{ id: "a", kind: "tool", text: "A" }], 0)).toEqual([]);
  });

  it("passes errors that are not native ranker errors through unchanged", async () => {
    const boom = new Error("boom");
    const { retrieve } = choiceRankerPlugin({
      rankAsync: async () => {
        throw boom;
      },
    });
    await expect(retrieve("q", [{ id: "a", kind: "tool", text: "A" }], 1)).rejects.toBe(boom);
  });
});

describe("the native ranker", () => {
  it("ships both vendors", () => {
    expect(vendors()).toEqual(["jev", "openai-decision"]);
  });

  it("builds a vendor's ranker", () => {
    expect(nativeRanker("jev")).toBeInstanceOf(ChoiceRanker);
  });

  it("rejects an unknown vendor at construction with a typed RetrieverError", () => {
    let error: unknown;
    try {
      nativeRanker("acme");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RetrieverError);
    expect(error).toMatchObject({
      code: "Config",
      transient: false,
      message: expect.stringContaining('"acme"'),
    });
    expect((error as Error).message).not.toContain("RATEL_RETRIEVER_ERROR:");
  });
});
