import { SearchTarget } from "@ratel-ai/telemetry";
import { type SearchHit, type Tool, ToolRegistry } from "../native/index.cjs";
import { argsSizeBytes, errorMessage, traceExecuteTool, traceSearch } from "./telemetry.js";

/**
 * The function that runs a tool. Receives the arguments object and may return
 * either a plain value or a `Promise` — {@link ToolCatalog.invoke} awaits both,
 * so synchronous executors need no wrapping.
 */
// biome-ignore lint/suspicious/noExplicitAny: tool inputs are heterogeneous across the catalog
export type Executor = (input: any) => Promise<unknown> | unknown;

/**
 * A tool the catalog can both retrieve *and* run: the searchable metadata of a
 * `Tool` (id, name, description, schemas) plus its {@link Executor}. The unit
 * {@link ToolCatalog.register} accepts and {@link ToolCatalog.getExecutable}
 * returns.
 */
export interface ExecutableTool extends Tool {
  /** Runs the tool. Called by {@link ToolCatalog.invoke} with the args object. */
  execute: Executor;
}

/**
 * Where the local trace stream (ADR-0007) goes. Distinct from the OTel spans in
 * {@link ToolCatalog}'s docs — this is the in-process channel drained via
 * {@link ToolCatalog.drainTraceEvents} or written to disk.
 *
 * - `"noop"` — discard every event (the default when no `trace` option is given).
 * - `"memory"` — buffer envelopes in-process; read them back with
 *   {@link ToolCatalog.drainTraceEvents}. `sessionId` is stamped on each envelope.
 * - `"jsonl"` — append one JSON envelope per line to the file at `path`
 *   (parent directories are created). `sessionId` is stamped on each envelope.
 */
export type TraceSinkConfig =
  | {
      /** Discard every event. */
      kind: "noop";
    }
  | {
      /** Buffer envelopes in-process for `drainTraceEvents`. */
      kind: "memory";
      /** Session id stamped on every envelope. */
      sessionId: string;
    }
  | {
      /** Append one JSON envelope per line to `path`. */
      kind: "jsonl";
      /** Session id stamped on every envelope. */
      sessionId: string;
      /** File to append to; parent directories are created. */
      path: string;
    };

/**
 * Who initiated a search: `"direct"` for host code calling the SDK itself
 * (pre-fetch helpers, benchmarks), `"agent"` for a call the model synthesized
 * through the capability tools (`search_capabilities`). Recorded on trace
 * events and the `ratel.origin` span attribute so consumers can separate the
 * two paths.
 */
export type SearchOrigin = "direct" | "agent";

/**
 * Retrieval engine for {@link ToolCatalog.search} (and the skill catalog's
 * `search`):
 *
 * - `"bm25"` — lexical ranking; model-free and infallible (the default).
 * - `"semantic"` — cosine similarity over prebuilt embeddings.
 * - `"hybrid"` — BM25 and semantic rankings fused with Reciprocal Rank Fusion
 *   (ADR-0011).
 *
 * `"semantic"`/`"hybrid"` require the embedding cache (built eagerly at
 * registration when they are the catalog default, or via `buildEmbeddings()`).
 */
export type SearchMethod = "bm25" | "semantic" | "hybrid";

/** Construction options for {@link ToolCatalog}. */
export interface ToolCatalogOptions {
  /** Local trace stream destination (default: discard). See {@link TraceSinkConfig}. */
  trace?: TraceSinkConfig;
  /** Default retrieval method for `search` (default `"bm25"`, model-free). A
   * per-call `method` argument overrides it. */
  method?: SearchMethod;
}

/**
 * In-process catalog of executable tools, ranked by the native Rust registry.
 * The SDK's central surface: {@link ToolCatalog.register} tools (or ingest an
 * MCP server's via `registerMcpServer`), {@link ToolCatalog.search} them by
 * relevance, and {@link ToolCatalog.invoke} the chosen one. Every operation
 * emits both an OTel span (to whatever provider is active — see telemetry.ts)
 * and a local trace event (to the sink from {@link ToolCatalogOptions.trace}),
 * per ADR-0007.
 *
 * @example
 * ```ts
 * import { ToolCatalog } from "@ratel-ai/sdk";
 * import { readFile } from "node:fs/promises";
 *
 * const catalog = new ToolCatalog();
 * catalog.register({
 *   id: "read_file",
 *   name: "read_file",
 *   description: "Read a file from local disk and return its textual contents.",
 *   inputSchema: {
 *     type: "object",
 *     properties: { path: { type: "string", description: "absolute path to the file" } },
 *     required: ["path"],
 *   },
 *   outputSchema: { type: "object" },
 *   execute: async ({ path }) => ({ contents: await readFile(path, "utf8") }),
 * });
 *
 * const [hit] = catalog.search("read a file from disk", 5);
 * const result = await catalog.invoke(hit.toolId, { path: "/tmp/notes.txt" });
 * ```
 */
export class ToolCatalog {
  private readonly registry: ToolRegistry;
  private readonly executors = new Map<string, Executor>();
  private readonly tools = new Map<string, Tool>();
  private readonly method: SearchMethod;
  private readonly eager: boolean;

  /**
   * Create an empty catalog.
   *
   * @param options - Trace sink and default retrieval method. A `"semantic"`/
   *   `"hybrid"` default makes every subsequent `register` embed the new tool
   *   immediately (loading the embedding model on first use); the `"bm25"`
   *   default stays model-free.
   */
  constructor(options: ToolCatalogOptions = {}) {
    this.registry = new ToolRegistry();
    this.method = options.method ?? "bm25";
    // Semantic/hybrid default → embed each tool at registration so searches
    // never pay the embedding cost. BM25 default does nothing.
    this.eager = this.method === "semantic" || this.method === "hybrid";
    if (options.trace) {
      this.registry.setTraceSink(options.trace);
    }
  }

  /**
   * Add a tool to the catalog, or replace it in place when the id is already
   * registered (metadata, executor, and index entry — the corpus never holds a
   * duplicate). On a semantic/hybrid catalog this also embeds the new tool
   * immediately, and throws if the embedding model fails to load.
   *
   * @param tool - The tool's searchable metadata plus its `execute` function.
   */
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

  /**
   * Pre-compute embeddings for any not-yet-embedded tools. Call after a bulk
   * register, or rely on the automatic per-register embedding a semantic/hybrid
   * catalog does. No-op for a BM25 catalog's cache. Incremental: only tools
   * registered since the last call are embedded. Throws if the embedding model
   * fails to load.
   */
  buildEmbeddings(): void {
    this.registry.buildEmbeddings();
  }

  /**
   * Search the catalog. `method` overrides the catalog default for this call.
   * `"semantic"`/`"hybrid"` rank against the prebuilt embedding cache and throw
   * `EmbeddingsNotBuilt` if it isn't built; they never load the model in-search (a
   * semantic/hybrid catalog builds embeddings eagerly at register).
   *
   * @param query - Natural-language description of what the caller wants to do.
   * @param topK - Maximum number of hits to return.
   * @param origin - Who initiated the call (default `"direct"`); recorded on
   *   the trace event and span, never affects ranking.
   * @param method - Per-call override of the catalog's default retrieval method.
   * @returns Up to `topK` hits, best-first with ties broken by tool id. The
   *   `score` scale depends on the method: a raw BM25 relevance score, a cosine
   *   similarity, or an RRF fusion score — comparable within one result list,
   *   not across methods.
   */
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

  /**
   * Whether a tool with this id is registered.
   *
   * @param toolId - The id to look up.
   * @returns `true` if {@link ToolCatalog.invoke} would find an executor for it.
   */
  has(toolId: string): boolean {
    return this.executors.has(toolId);
  }

  /**
   * Look up a tool's searchable metadata (no executor attached).
   *
   * @param toolId - The id to look up.
   * @returns The metadata as registered, or `undefined` for an unknown id.
   */
  get(toolId: string): Tool | undefined {
    return this.tools.get(toolId);
  }

  /**
   * Look up a tool with its executor reattached.
   *
   * @param toolId - The id to look up.
   * @returns A copy of the registered tool including `execute`, or `undefined`
   *   for an unknown id.
   */
  getExecutable(toolId: string): ExecutableTool | undefined {
    const tool = this.tools.get(toolId);
    const execute = this.executors.get(toolId);
    if (!tool || !execute) return undefined;
    return { ...tool, execute };
  }

  /**
   * Record a custom event on the local trace stream (ADR-0007), e.g. an
   * `upstream_register` from an ingestion layer. Delivered to the sink
   * configured at construction; a no-op sink discards it.
   *
   * @param event - A tagged trace event in wire shape: `{ type: "...", ... }`
   *   with snake_case fields. Throws if the object is not a known trace event.
   */
  recordEvent(event: object): void {
    this.registry.recordEvent(event);
  }

  /**
   * Drain the envelopes captured by a `"memory"` trace sink, emptying its
   * buffer.
   *
   * @returns The captured envelopes (`{ v, ts, session_id, type, ... }` — the
   *   event fields are flattened alongside the envelope stamp) in record
   *   order. Always `[]` unless the active sink is `"memory"`.
   */
  drainTraceEvents(): unknown[] {
    return this.registry.drainTraceEvents();
  }

  /**
   * Run a registered tool's executor. Sync-absorbing: the executor may return
   * a plain value or a `Promise` (both are awaited), and a synchronous `throw`
   * inside it surfaces as a rejection of the returned promise — `invoke` never
   * throws synchronously, including for an unknown `toolId` (that rejects with
   * `unknown toolId: …`).
   *
   * The call is wrapped in an `execute_tool` OTel span and bracketed by
   * `invoke_start` / `invoke_end` (or `invoke_error`, with the error message)
   * events on the local trace stream, `took_ms` in wall-clock milliseconds.
   *
   * @param toolId - Id of a registered tool.
   * @param args - Arguments object passed through to the executor unchanged.
   * @returns Whatever the executor returns (resolved if it returned a promise).
   */
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
