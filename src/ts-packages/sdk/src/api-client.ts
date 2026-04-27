import type {
  ApiClientConfig,
  AgentifiedEvent,
  AppendMessagesResponse,
  CaptureTurnOptions,
  ContextStrategy,
  CaptureTurnResponse,
  ContextOpts,
  ContextResponse,
  DiscoverResponse,
  DiscoverTool,
  DiscoverToolInput,
  GetMessagesOpts,
  GetMessagesResponse,
  GetMessagesTool,
  GetMessagesToolInput,
  ListSkillsResponse,
  Message,
  PrefetchOptions,
  RankedTool,
  RegisterResponse,
  RegisterSkillsResponse,
  SearchStrategy,
  ServerTool,
  Skill,
} from "./types.js";

export class ApiClient {
  private config: ApiClientConfig;

  constructor(config: ApiClientConfig) {
    this.config = config;
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const headers = this.config.headers
      ? { ...this.config.headers, ...init?.headers }
      : init?.headers;
    const res = await fetch(url, { ...init, ...(headers ? { headers } : {}) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Agentified API error ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async register(datasetId: string): Promise<RegisterResponse> {
    const tools = this.config.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.metadata ? { metadata: t.metadata } : {}),
      ...(t.fields ? { fields: t.fields } : {}),
      ...(t.alwaysInclude !== undefined ? { always_include: t.alwaysInclude } : {}),
    }));
    return this.fetchJson<RegisterResponse>(`${this.config.serverUrl}/api/v1/datasets/${datasetId}/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools }),
    });
  }

  async registerSkills(datasetId: string, skills: Skill[]): Promise<RegisterSkillsResponse> {
    const wireSkills = skills.map((s) => ({
      name: s.name,
      description: s.description,
      ...(s.intent !== undefined ? { intent: s.intent } : {}),
      atoms: s.atoms,
      ...(s.edges ? { edges: s.edges } : {}),
      ...(s.metadata ? { metadata: s.metadata } : {}),
    }));
    return this.fetchJson<RegisterSkillsResponse>(
      `${this.config.serverUrl}/api/v1/datasets/${datasetId}/skills`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skills: wireSkills }),
      },
    );
  }

  async listSkills(datasetId: string): Promise<Skill[]> {
    const data = await this.fetchJson<ListSkillsResponse>(
      `${this.config.serverUrl}/api/v1/datasets/${datasetId}/skills`,
      { method: "GET" },
    );
    return data.skills ?? [];
  }

  async discover(datasetId: string, query: string, limit?: number, exclude?: string[], turnId?: string, strategy?: SearchStrategy, namespace?: string, session?: string): Promise<RankedTool[]> {
    const body: Record<string, unknown> = { query };
    if (limit !== undefined) body.limit = limit;
    if (exclude !== undefined) body.exclude = exclude;
    if (turnId !== undefined) body.turn_id = turnId;
    if (namespace !== undefined) body.namespace = namespace;
    if (session !== undefined) body.session = session;
    body.strategy = strategy ?? this.config.strategy ?? "bm25";

    const data = await this.fetchJson<DiscoverResponse>(`${this.config.serverUrl}/api/v1/datasets/${datasetId}/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return data.tools ?? [];
  }

  async prefetch(datasetId: string, options: PrefetchOptions): Promise<RankedTool[]> {
    this.emit({ type: "agentified:prefetch:start", messages: options.messages });
    const start = performance.now();

    const query = options.messages.map((m) => m.content).join("\n");
    const tools = await this.discover(datasetId, query, options.limit, options.exclude, options.turnId, options.strategy);

    this.emit({
      type: "agentified:prefetch:complete",
      tools,
      durationMs: performance.now() - start,
    });
    return tools;
  }

  async captureTurn(namespace: string, session: string, options: CaptureTurnOptions): Promise<CaptureTurnResponse> {
    const data = await this.fetchJson<{ turn_id: string }>(`${this.config.serverUrl}/api/v1/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace_id: namespace,
        session_id: session,
        tools_loaded: options.toolsLoaded,
        message: options.message,
      }),
    });
    return { turnId: data.turn_id };
  }

  async appendMessages(dataset: string, namespace: string, session: string, messages: Message[]): Promise<AppendMessagesResponse> {
    const data = await this.fetchJson<{ appended: number; first_seq: number; last_seq: number }>(`${this.config.serverUrl}/api/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset, namespace, session, messages }),
    });
    return { appended: data.appended, firstSeq: data.first_seq, lastSeq: data.last_seq };
  }

  async getMessages(dataset: string, namespace: string, session: string, opts?: GetMessagesOpts): Promise<GetMessagesResponse> {
    const params = new URLSearchParams({ dataset, namespace, session });
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.afterSeq !== undefined) params.set("after_seq", String(opts.afterSeq));
    if (opts?.aroundSeq !== undefined) params.set("around_seq", String(opts.aroundSeq));

    const data = await this.fetchJson<{ messages: any[]; has_more: boolean; max_seq: number }>(`${this.config.serverUrl}/api/v1/messages?${params}`, {
      method: "GET",
    });
    return {
      messages: data.messages.map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolCallId: m.tool_call_id,
        toolCalls: m.tool_calls,
        createdAt: m.created_at,
        seq: m.seq,
      })),
      hasMore: data.has_more,
      maxSeq: data.max_seq,
    };
  }

  async getContext(dataset: string, namespace: string, session: string, opts?: ContextOpts): Promise<ContextResponse> {
    const messagesConfig: Record<string, unknown> = {};
    messagesConfig.strategy = opts?.strategy ?? this.config.strategy ?? "bm25";
    if (opts?.maxTokens !== undefined) messagesConfig.max_tokens = opts.maxTokens;
    if (opts?.keepFirst !== undefined) messagesConfig.keep_first = opts.keepFirst;
    if (opts?.pruneThreshold !== undefined) messagesConfig.prune_threshold = opts.pruneThreshold;

    const body: Record<string, unknown> = { dataset, namespace, session, messages: messagesConfig };
    if (opts?.recall) {
      const recall: Record<string, unknown> = {};
      if (opts.recall.tools !== undefined) {
        if (typeof opts.recall.tools === "boolean") {
          recall.tools = opts.recall.tools;
        } else {
          const toolsConfig: Record<string, unknown> = {};
          if (opts.recall.tools.limit !== undefined) toolsConfig.limit = opts.recall.tools.limit;
          if (opts.recall.tools.minSimilarity !== undefined) toolsConfig.min_similarity = opts.recall.tools.minSimilarity;
          recall.tools = toolsConfig;
        }
      }
      body.recall = recall;
    }
    if (opts?.limitTokens !== undefined) body.limit_tokens = opts.limitTokens;

    const data = await this.fetchJson<{
      messages: any[];
      strategy_used: string;
      total_messages: number;
      included_messages: number;
      recalled: { tools: any[]; memories: unknown[] };
      token_estimate: number;
      conversation_messages: number;
      fallback: boolean;
      summary?: string;
      summary_range?: { first_seq: number; last_seq: number; count: number };
    }>(`${this.config.serverUrl}/api/v1/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      messages: data.messages.map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolCallId: m.tool_call_id,
        toolCalls: m.tool_calls,
        createdAt: m.created_at,
        seq: m.seq,
      })),
      strategyUsed: data.strategy_used as ContextStrategy,
      totalMessages: data.total_messages,
      includedMessages: data.included_messages,
      recalled: data.recalled,
      tokenEstimate: data.token_estimate,
      conversationMessages: data.conversation_messages,
      fallback: data.fallback,
      summary: data.summary,
      summaryRange: data.summary_range
        ? { firstSeq: data.summary_range.first_seq, lastSeq: data.summary_range.last_seq, count: data.summary_range.count }
        : undefined,
    };
  }

  getFrontendTools(): ServerTool[] {
    return this.config.tools.filter((t) => t.metadata?.location === "frontend");
  }

  getFrontendToolNames(): string[] {
    return this.getFrontendTools().map((t) => t.name);
  }

  asGetMessagesTool(dataset: string, namespace: string, session: string): GetMessagesTool {
    return {
      definition: {
        name: "agentified_get_messages",
        description: "Retrieve conversation messages by sequence number. Use this to read messages that were summarized or excluded from your current context. Returns messages in chronological order.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max messages to return (default: 20)" },
            afterSeq: { type: "number", description: "Return messages after this sequence number (paginate forward)" },
            aroundSeq: { type: "number", description: "Return messages around this sequence number (centered window)" },
          },
        },
      },
      execute: async (input: GetMessagesToolInput) => {
        return this.getMessages(dataset, namespace, session, {
          limit: input.limit ?? 20,
          afterSeq: input.afterSeq,
          aroundSeq: input.aroundSeq,
        });
      },
    };
  }

  asDiscoverTool(datasetId: string, namespace?: string, session?: string): DiscoverTool {
    const discoveredNames = new Set<string>();
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
      discoveredNames,
      execute: async (input: DiscoverToolInput): Promise<RankedTool[]> => {
        this.emit({ type: "agentified:discover:start", query: input.query });
        const start = performance.now();

        const tools = await this.discover(datasetId, input.query, input.limit, undefined, undefined, input.strategy, namespace, session);
        for (const t of tools) discoveredNames.add(t.name);

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
