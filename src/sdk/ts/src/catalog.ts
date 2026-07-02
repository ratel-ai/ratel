import { type SearchHit, type Tool, ToolRegistry, type TraceSession } from "../native/index.cjs";

// biome-ignore lint/suspicious/noExplicitAny: tool inputs are heterogeneous across the catalog
export type Executor = (input: any) => Promise<unknown> | unknown;

export interface ExecutableTool extends Tool {
  execute: Executor;
}

/** Optional envelope context stamped on every event — see ADR-0013. */
export interface TraceContext {
  harness?: string;
  environment?: string;
  sdkVersion?: string;
  catalogVersion?: string;
}

export type TraceSinkConfig =
  | { kind: "noop" }
  | ({ kind: "memory"; sessionId: string } & TraceContext)
  | ({ kind: "jsonl"; sessionId: string; path: string } & TraceContext);

export type SearchOrigin = "direct" | "agent";

export interface TracedSearch {
  /** Id stamped on the emitted search event — attributed to later invokes. */
  searchId: string;
  hits: SearchHit[];
}

export interface ToolCatalogOptions {
  trace?: TraceSinkConfig;
  /**
   * Shared session buffer (one per process/session). Attach the same session
   * to every catalog so `(session_id, seq)` stays unique and the Cloud
   * exporter has a single drain point. Takes precedence over `trace`.
   */
  traceSession?: TraceSession;
}

export class ToolCatalog {
  private readonly registry: ToolRegistry;
  private readonly executors = new Map<string, Executor>();
  private readonly tools = new Map<string, Tool>();
  /** tool id → id of the most recent search that surfaced it (ADR-0013). */
  private readonly lastSearchIdByTool = new Map<string, string>();

  constructor(options: ToolCatalogOptions = {}) {
    this.registry = new ToolRegistry();
    if (options.traceSession) {
      this.registry.attachTraceSession(options.traceSession);
    } else if (options.trace) {
      this.registry.setTraceSink(options.trace);
    }
  }

  register(tool: ExecutableTool): void {
    const { execute, ...metadata } = tool;
    this.registry.register(metadata);
    this.executors.set(tool.id, execute);
    this.tools.set(tool.id, metadata);
  }

  search(query: string, topK: number, origin: SearchOrigin = "direct"): SearchHit[] {
    return this.searchTraced(query, topK, origin).hits;
  }

  /** Like {@link search}, but also returns the emitted event's `search_id`. */
  searchTraced(query: string, topK: number, origin: SearchOrigin = "direct"): TracedSearch {
    const outcome = this.registry.searchWithTrace(query, topK, origin);
    for (const hit of outcome.hits) {
      this.lastSearchIdByTool.set(hit.toolId, outcome.searchId);
    }
    return outcome;
  }

  /** Id of the most recent search that surfaced this tool, if any. */
  lastSearchId(toolId: string): string | undefined {
    return this.lastSearchIdByTool.get(toolId);
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
    const searchId = this.lastSearchIdByTool.get(toolId);
    const attribution = searchId ? { search_id: searchId } : {};
    this.registry.recordEvent({
      type: "invoke_start",
      tool_id: toolId,
      args_size_bytes: jsonSizeBytes(args),
      ...attribution,
    });
    const started = Date.now();
    try {
      const result = await fn(args);
      this.registry.recordEvent({
        type: "invoke_end",
        tool_id: toolId,
        took_ms: Date.now() - started,
        result_size_bytes: jsonSizeBytes(result),
        ...attribution,
      });
      return result;
    } catch (err) {
      const unauthorized = err instanceof Error && err.name === "UnauthorizedError";
      this.registry.recordEvent({
        type: "invoke_error",
        tool_id: toolId,
        took_ms: Date.now() - started,
        error: errorMessage(err),
        ...attribution,
        ...(unauthorized ? { error_code: "needs_auth", error_kind: "transient" } : {}),
      });
      throw err;
    }
  }
}

function jsonSizeBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
