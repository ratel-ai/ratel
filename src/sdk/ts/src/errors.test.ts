import { describe, expect, it } from "vitest";
import { mapEmbedderError } from "./errors.js";
import { DimensionMismatchError, EmbedderError } from "./index.js";

describe("mapEmbedderError", () => {
  // Each core `EmbedderError` display signature → its typed class + code.
  const cases: Array<[string, string, string]> = [
    ["Load", "failed to load embedding model /x: missing model.safetensors (hint: …)", "Load"],
    [
      "Download",
      "failed to download embedding model bge: connection refused (hint: …)",
      "Download",
    ],
    [
      "CacheUnwritable",
      "embedding model cache is not writable: permission denied (hint: …)",
      "CacheUnwritable",
    ],
    ["Inference", "embedding failed: tokenizer error (hint: …)", "Inference"],
    [
      "ModelMismatch",
      "embedding model mismatch: cache was built with A, active model is B (hint: …)",
      "ModelMismatch",
    ],
    [
      "NotCached",
      "embedding model bge-base is not in the local HuggingFace cache — download it first (hint: …)",
      "NotCached",
    ],
  ];

  for (const [name, message, code] of cases) {
    it(`maps a ${name} error to EmbedderError with code "${code}"`, () => {
      const mapped = mapEmbedderError(new Error(message));
      expect(mapped).toBeInstanceOf(EmbedderError);
      expect(mapped).not.toBeInstanceOf(DimensionMismatchError);
      expect((mapped as EmbedderError).code).toBe(code);
      expect((mapped as EmbedderError).message).toBe(message); // message preserved verbatim
    });
  }

  it("maps a dimension mismatch to DimensionMismatchError (a subclass of EmbedderError)", () => {
    const message = "embedding dimension mismatch for bge: expected 384, got 768 (hint: …)";
    const mapped = mapEmbedderError(new Error(message));
    expect(mapped).toBeInstanceOf(DimensionMismatchError);
    expect(mapped).toBeInstanceOf(EmbedderError);
    expect((mapped as DimensionMismatchError).code).toBe("DimensionMismatch");
    expect((mapped as DimensionMismatchError).message).toBe(message);
  });

  it("appends the await-register hint to a not-built error, keeping the original text", () => {
    const message = "embeddings are not computed for semantic search (hint: …)";
    const mapped = mapEmbedderError(new Error(message)) as EmbedderError;
    expect(mapped).toBeInstanceOf(EmbedderError);
    expect(mapped.code).toBe("EmbeddingsNotBuilt");
    expect(mapped.message).toContain("not computed for semantic"); // existing matcher
    expect(mapped.message).toContain("without awaiting it"); // added hint
  });

  it("passes non-embedding errors through unchanged", () => {
    for (const message of [
      "registry busy; await the active operation before registering more items",
      "tool registry lock poisoned",
      "semantic and hybrid search are asynchronous; use searchWithMethodAsync()",
      "embedding 'local' must not be blank (hint: …)", // construction-time config error
    ]) {
      const original = new Error(message);
      expect(mapEmbedderError(original)).toBe(original); // same reference, untouched
    }
    const notError = { message: "failed to load embedding model x" };
    expect(mapEmbedderError(notError)).toBe(notError);
  });
});
