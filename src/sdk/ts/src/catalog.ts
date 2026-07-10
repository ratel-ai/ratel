import { SearchTarget } from "@ratel-ai/telemetry";
import {
  type EmbeddingConfig as NativeEmbeddingConfig,
  type SearchHit,
  type Tool,
  ToolRegistry,
} from "../native/index.cjs";
import { argsSizeBytes, errorMessage, traceExecuteTool, traceSearch } from "./telemetry.js";

// biome-ignore lint/suspicious/noExplicitAny: tool inputs are heterogeneous across the catalog
export type Executor = (input: any) => Promise<unknown> | unknown;

export interface ExecutableTool extends Tool {
  execute: Executor;
}

export type TraceSinkConfig =
  | { kind: "noop" }
  | { kind: "memory"; sessionId: string }
  | { kind: "jsonl"; sessionId: string; path: string };

export type SearchOrigin = "direct" | "agent";

export type SearchMethod = "bm25" | "semantic" | "hybrid";

/** Object form of the embedding-model selection for semantic/hybrid retrieval.
 * The discriminating key names the source — symmetric across all of them. Use
 * the bare string form only for a local model *directory path*. */
export type EmbeddingModelConfig =
  | { huggingface: string; revision?: string; queryPrefix?: string }
  | { local: string; queryPrefix?: string }
  | { ollama: string; queryPrefix?: string }
  | { url: string; model: string; apiKeyEnv?: string; queryPrefix?: string };

/** Embedding-model selection: a bare string is a **local model directory path**;
 * every other source is an explicit {@link EmbeddingModelConfig} object. */
export type EmbeddingSpec = string | EmbeddingModelConfig;

/** Normalize the public string|object form into the native config the binding
 * expects (a string is the local-path `spec`, validated in core). */
function toNativeEmbedding(embedding: EmbeddingSpec): NativeEmbeddingConfig {
  return typeof embedding === "string" ? { spec: embedding } : embedding;
}

export interface ToolCatalogOptions {
  trace?: TraceSinkConfig;
  /** Default retrieval method for `search` (default `"bm25"`, model-free). A
   * per-call `method` argument overrides it. */
  method?: SearchMethod;
  /** Embedding model backing semantic/hybrid retrieval. A string is a local
   * model directory path (`"/opt/models/bge"`); every other source is a keyed
   * object: `{ huggingface: "BAAI/bge-base-en-v1.5" }`, `{ ollama: "…" }`, or
   * `{ url, model, apiKeyEnv }`. Chosen once, used for both document and query
   * embedding. Ignored (with a warning) when method is `"bm25"`, which needs no
   * model. An invalid config throws at construction. */
  embedding?: EmbeddingSpec;
}

export class ToolCatalog {
  private readonly registry: ToolRegistry;
  private readonly executors = new Map<string, Executor>();
  private readonly tools = new Map<string, Tool>();
  private readonly method: SearchMethod;
  private readonly eager: boolean;

  constructor(options: ToolCatalogOptions = {}) {
    this.method = options.method ?? "bm25";
    // Semantic/hybrid default → embed each tool at registration so searches
    // never pay the embedding cost. BM25 default does nothing.
    this.eager = this.method === "semantic" || this.method === "hybrid";
    if (options.embedding && !this.eager) {
      console.warn(
        'ratel: `embedding` was provided but method is "bm25", which needs no model — the embedding config is ignored',
      );
    }
    // A bm25 catalog ignores the model entirely (never loads it).
    this.registry = new ToolRegistry(
      this.eager && options.embedding ? toNativeEmbedding(options.embedding) : undefined,
    );
    if (options.trace) {
      this.registry.setTraceSink(options.trace);
    }
  }

  register(tool: ExecutableTool): void {
    const { execute, ...metadata } = tool;
    this.registry.register(metadata);
    this.executors.set(tool.id, execute);
    this.tools.set(tool.id, metadata);
    if (this.eager) {
      // Embed the just-registered tool now (incremental). Throws if the model
      // fails to load.
      this.registry.buildEmbeddings();
    }
  }

  /** Pre-compute embeddings for any not-yet-embedded tools. Call after a bulk
   * register, or rely on the automatic per-register embedding a semantic/hybrid
   * catalog does. No-op for a BM25 catalog's cache. */
  buildEmbeddings(): void {
    this.registry.buildEmbeddings();
  }

  /** Search the catalog. `method` overrides the catalog default for this call.
   * `"semantic"`/`"hybrid"` rank against the prebuilt embedding cache and throw
   * `EmbeddingsNotBuilt` if it isn't built; they never load the model in-search (a
   * semantic/hybrid catalog builds embeddings eagerly at register). */
  search(
    query: string,
    topK: number,
    origin: SearchOrigin = "direct",
    method?: SearchMethod,
  ): SearchHit[] {
    return traceSearch(SearchTarget.Tool, query, topK, origin, () =>
      this.registry.searchWithMethod(query, topK, origin, method ?? this.method),
    );
  }

  has(toolId: string): boolean {
    return this.executors.has(toolId);
  }

  get(toolId: string): Tool | undefined {
    return this.tools.get(toolId);
  }

  getExecutable(toolId: string): ExecutableTool | undefined {
    const tool = this.tools.get(toolId);
    const execute = this.executors.get(toolId);
    if (!tool || !execute) return undefined;
    return { ...tool, execute };
  }

  recordEvent(event: object): void {
    this.registry.recordEvent(event);
  }

  drainTraceEvents(): unknown[] {
    return this.registry.drainTraceEvents();
  }

  async invoke(toolId: string, args: Record<string, unknown>): Promise<unknown> {
    const fn = this.executors.get(toolId);
    if (!fn) {
      throw new Error(`unknown toolId: ${toolId}`);
    }
    // The `execute_tool` OTel span wraps the local trace stream; both record the
    // same invocation, on their two independent channels (ADR-0007).
    return traceExecuteTool(toolId, args, async () => {
      this.registry.recordEvent({
        type: "invoke_start",
        tool_id: toolId,
        args_size_bytes: argsSizeBytes(args),
      });
      const started = Date.now();
      try {
        const result = await fn(args);
        this.registry.recordEvent({
          type: "invoke_end",
          tool_id: toolId,
          took_ms: Date.now() - started,
        });
        return result;
      } catch (err) {
        this.registry.recordEvent({
          type: "invoke_error",
          tool_id: toolId,
          took_ms: Date.now() - started,
          error: errorMessage(err),
        });
        throw err;
      }
    });
  }
}
