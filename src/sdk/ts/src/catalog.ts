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

export interface ToolCatalogOptions {
  trace?: TraceSinkConfig;
}

export class ToolCatalog {
  private readonly registry: ToolRegistry;
  private readonly executors = new Map<string, Executor>();
  private readonly tools = new Map<string, Tool>();

  constructor(options: ToolCatalogOptions = {}) {
    this.registry = new ToolRegistry();
    if (options.trace) {
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
    return this.registry.searchWithOrigin(query, topK, origin);
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
