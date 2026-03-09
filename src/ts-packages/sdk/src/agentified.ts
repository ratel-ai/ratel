import type {
  ApiClientConfig,
  AgentifiedEvent,
  CaptureTurnOptions,
  CaptureTurnResponse,
  DiscoverResponse,
  DiscoverTool,
  DiscoverToolInput,
  PrefetchOptions,
  RankedTool,
  RegisterResponse,
  ServerTool,
} from "./types.js";

export class ApiClient {
  private config: ApiClientConfig;

  constructor(config: ApiClientConfig) {
    this.config = config;
  }

  async createInstance(dataset: string): Promise<{ instanceId: string }> {
    const res = await fetch(`${this.config.serverUrl}/api/v1/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset }),
    });
    const data = (await res.json()) as { instance_id: string };
    return { instanceId: data.instance_id };
  }

  async heartbeatInstance(instanceId: string): Promise<void> {
    await fetch(`${this.config.serverUrl}/api/v1/instances/${instanceId}/heartbeat`, {
      method: "POST",
    });
  }

  async deleteInstance(instanceId: string): Promise<void> {
    await fetch(`${this.config.serverUrl}/api/v1/instances/${instanceId}`, {
      method: "DELETE",
    });
  }

  async register(instanceId: string): Promise<RegisterResponse> {
    const res = await fetch(`${this.config.serverUrl}/api/v1/instances/${instanceId}/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: this.config.tools }),
    });
    return res.json() as Promise<RegisterResponse>;
  }

  async discover(instanceId: string, query: string, limit?: number, exclude?: string[], turnId?: string): Promise<RankedTool[]> {
    const body: Record<string, unknown> = { query };
    if (limit !== undefined) body.limit = limit;
    if (exclude !== undefined) body.exclude = exclude;
    if (turnId !== undefined) body.turn_id = turnId;

    const res = await fetch(`${this.config.serverUrl}/api/v1/instances/${instanceId}/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as DiscoverResponse;
    return data.tools ?? [];
  }

  async prefetch(instanceId: string, options: PrefetchOptions): Promise<RankedTool[]> {
    this.emit({ type: "agentified:prefetch:start", messages: options.messages });
    const start = performance.now();

    const query = options.messages.map((m) => m.content).join("\n");
    const tools = await this.discover(instanceId, query, options.limit, options.exclude, options.turnId);

    this.emit({
      type: "agentified:prefetch:complete",
      tools,
      durationMs: performance.now() - start,
    });
    return tools;
  }

  async captureTurn(instanceId: string, namespace: string, session: string, options: CaptureTurnOptions): Promise<CaptureTurnResponse> {
    const res = await fetch(`${this.config.serverUrl}/api/v1/instances/${instanceId}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace_id: namespace,
        session_id: session,
        tools_loaded: options.toolsLoaded,
        message: options.message,
      }),
    });
    const data = (await res.json()) as { turn_id: string };
    return { turnId: data.turn_id };
  }

  getFrontendTools(): ServerTool[] {
    return this.config.tools.filter((t) => t.metadata?.location === "frontend");
  }

  getFrontendToolNames(): string[] {
    return this.getFrontendTools().map((t) => t.name);
  }

  asDiscoverTool(instanceId: string): DiscoverTool {
    return {
      definition: {
        name: "agentified_discover",
        description: "Find tools relevant to the current task. Call this when you need capabilities you don't have.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language description of what you need to do" },
            limit: { type: "number", description: "Max number of tools to return" },
          },
          required: ["query"],
        },
      },
      execute: async (input: DiscoverToolInput): Promise<RankedTool[]> => {
        this.emit({ type: "agentified:discover:start", query: input.query });
        const start = performance.now();

        const tools = await this.discover(instanceId, input.query, input.limit);

        this.emit({
          type: "agentified:discover:complete",
          query: input.query,
          tools,
          durationMs: performance.now() - start,
        });
        return tools;
      },
    };
  }

  private emit(event: AgentifiedEvent): void {
    this.config.onEvent?.(event);
  }
}
