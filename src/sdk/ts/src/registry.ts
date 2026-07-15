import {
  type EmbeddingConfig as NativeEmbeddingConfig,
  SkillRegistry as NativeSkillRegistry,
  ToolRegistry as NativeToolRegistry,
} from "../native/index.cjs";
import type { EmbeddingSpec } from "./catalog.js";

/** Metadata-only native tool registry with the SDK's exclusive embedding config. */
export class ToolRegistry extends NativeToolRegistry {
  constructor(embedding?: EmbeddingSpec) {
    super(toNativeEmbedding(embedding));
  }
}

/** Metadata-only native skill registry with the SDK's exclusive embedding config. */
export class SkillRegistry extends NativeSkillRegistry {
  constructor(embedding?: EmbeddingSpec) {
    super(toNativeEmbedding(embedding));
  }
}

function toNativeEmbedding(
  embedding: EmbeddingSpec | undefined,
): NativeEmbeddingConfig | undefined {
  if (embedding === undefined) return undefined;
  return typeof embedding === "string" ? { spec: embedding } : embedding;
}
