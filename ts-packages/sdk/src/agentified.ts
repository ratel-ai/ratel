import type {
  AgentifiedConfig,
  AgentifiedEvent,
  DiscoverResponse,
  DiscoverTool,
  DiscoverToolInput,
  PrefetchOptions,
  RankedTool,
  RegisterResponse,
} from "./types.js";

export class Agentified {
  private config: AgentifiedConfig;

  constructor(config: AgentifiedConfig) {
    this.config = config;
  }

  async register(): Promise<RegisterResponse> {
    const res = await fetch(`${this.config.serverUrl}/api/v1/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: this.config.tools }),
    });
    return res.json() as Promise<RegisterResponse>;
  }

  async prefetch(options: PrefetchOptions): Promise<RankedTool[]> {
    this.emit({ type: "agentified:prefetch:start", messages: options.messages });
    const start = performance.now();

    const query = options.messages.map((m) => m.content).join("\n");
    const tools = await this.discover(query, options.limit);

    this.emit({
      type: "agentified:prefetch:complete",
      tools,
      durationMs: performance.now() - start,
    });
    return tools;
  }

  asDiscoverTool(): DiscoverTool {
    return {
      definition: {
        name: "agentified_discover",
        description: "Discover relevant tools from Agentified",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query for tool discovery" },
            limit: { type: "number", description: "Max number of tools to return" },
          },
          required: ["query"],
        },
      },
      execute: async (input: DiscoverToolInput): Promise<RankedTool[]> => {
        this.emit({ type: "agentified:discover:start", query: input.query });
        const start = performance.now();

        const tools = await this.discover(input.query, input.limit);

        this.emit({
          type: "agentified:discover:complete",
          tools,
          durationMs: performance.now() - start,
        });
        return tools;
      },
    };
  }

  private async discover(query: string, limit?: number): Promise<RankedTool[]> {
    const res = await fetch(`${this.config.serverUrl}/api/v1/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
    });
    const data = (await res.json()) as DiscoverResponse;
    return data.tools;
  }

  private emit(event: AgentifiedEvent): void {
    this.config.onEvent?.(event);
  }
}
