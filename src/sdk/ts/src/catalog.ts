import { type SearchHit, type Tool, ToolRegistry } from "../native/index.cjs";

// biome-ignore lint/suspicious/noExplicitAny: tool inputs are heterogeneous across the catalog
export type Executor = (input: any) => Promise<unknown> | unknown;

export interface ExecutableTool extends Tool {
  execute: Executor;
}

export class ToolCatalog {
  private readonly registry: ToolRegistry;
  private readonly executors = new Map<string, Executor>();
  private readonly tools = new Map<string, Tool>();

  constructor() {
    this.registry = new ToolRegistry();
  }

  register(tool: ExecutableTool): void {
    const { execute, ...metadata } = tool;
    this.registry.register(metadata);
    this.executors.set(tool.id, execute);
    this.tools.set(tool.id, metadata);
  }

  search(query: string, topK: number): SearchHit[] {
    return this.registry.search(query, topK);
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

  async invoke(toolId: string, args: Record<string, unknown>): Promise<unknown> {
    const fn = this.executors.get(toolId);
    if (!fn) {
      throw new Error(`unknown toolId: ${toolId}`);
    }
    return await fn(args);
  }
}
