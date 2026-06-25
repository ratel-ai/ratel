import { type SearchHit, type Tool, ToolRegistry } from "../native/index.cjs";

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

/** Ratel's tokens-saved metric for one search: full catalog vs the selected top-K. */
export interface ToolSavings {
  fullCatalogTokens: number;
  selectedTokens: number;
  tokensSaved: number;
  topK: number;
}

export interface ToolCatalogOptions {
  trace?: TraceSinkConfig;
  /**
   * Record Ratel's tokens-saved metric (full catalog vs selected top-K, computed
   * natively in `ratel-ai-core`) on every search — onto the local trace stream and
   * `lastSavings`, ready to fold into a cloud `RatelClient.track(...)` rollup.
   */
  observe?: boolean;
}

export class ToolCatalog {
  private readonly registry: ToolRegistry;
  private readonly executors = new Map<string, Executor>();
  private readonly tools = new Map<string, Tool>();
  private readonly observe: boolean;
  /** The most recent search's savings (full vs selected tokens), or undefined. */
  lastSavings: ToolSavings | undefined;

  constructor(options: ToolCatalogOptions = {}) {
    this.registry = new ToolRegistry();
    if (options.trace) {
      this.registry.setTraceSink(options.trace);
    }
    this.observe = options.observe ?? false;
  }

  register(tool: ExecutableTool): void {
    const { execute, ...metadata } = tool;
    this.registry.register(metadata);
    this.executors.set(tool.id, execute);
    this.tools.set(tool.id, metadata);
  }

  search(query: string, topK: number, origin: SearchOrigin = "direct"): SearchHit[] {
    const hits = this.registry.searchWithOrigin(query, topK, origin);
    if (this.observe) {
      this.emitSavings(hits, topK);
    }
    return hits;
  }

  /**
   * Record the full-catalog-vs-top-K token saving. Best-effort: never throws.
   * The footprint maths run in the core (`catalogTokens` / `tokensFor`).
   */
  private emitSavings(hits: SearchHit[], topK: number): void {
    try {
      const full = Math.trunc(this.registry.catalogTokens());
      const selected = Math.trunc(this.registry.tokensFor(hits.map((hit) => hit.toolId)));
      const tokensSaved = Math.max(0, full - selected);
      this.lastSavings = {
        fullCatalogTokens: full,
        selectedTokens: selected,
        tokensSaved,
        topK,
      };
      this.registry.recordEvent({
        type: "tokens_saved",
        trace_id: "",
        full_catalog_tokens: full,
        selected_tokens: selected,
        top_k: topK,
      });
    } catch {
      // never break search over an observability side-effect
    }
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
  }
}

function argsSizeBytes(args: unknown): number {
  try {
    return JSON.stringify(args).length;
  } catch {
    return 0;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
