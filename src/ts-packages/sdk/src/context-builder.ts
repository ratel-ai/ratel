import type { ApiClient } from "./api-client.js";
import type { AgentifiedTool, AssembledContext, ContextStrategy, RecallConfig } from "./types.js";

export class ContextBuilder<T = AgentifiedTool> {
  private messageOpts: { strategy?: ContextStrategy; maxTokens?: number; keepFirst?: boolean } = {};
  private recallOpts?: RecallConfig;
  private tokenLimit?: number;
  private explicitTools: Record<string, T> = {};

  constructor(
    private readonly sdk: ApiClient,
    private readonly datasetId: string,
    private readonly namespaceId: string,
    private readonly sessionId: string,
    private readonly registeredTools: T[] = [],
    private readonly discoveredNames: Set<string> = new Set(),
  ) {}

  tools(tools: Record<string, T>): this {
    Object.assign(this.explicitTools, tools);
    return this;
  }

  messages(opts: { strategy?: ContextStrategy; maxTokens?: number; keepFirst?: boolean }): this {
    this.messageOpts = opts;
    return this;
  }

  recall(opts?: RecallConfig): this {
    this.recallOpts = opts ?? { tools: true };
    return this;
  }

  limitTokens(budget: number): this {
    this.tokenLimit = budget;
    return this;
  }

  async assemble(): Promise<AssembledContext<T>> {
    const res = await this.sdk.getContext(this.datasetId, this.namespaceId, this.sessionId, {
      strategy: this.messageOpts.strategy,
      maxTokens: this.messageOpts.maxTokens,
      keepFirst: this.messageOpts.keepFirst,
      recall: this.recallOpts,
      limitTokens: this.tokenLimit,
    });

    const resolvedTools: Record<string, T> = { ...this.explicitTools };
    for (const tool of this.registeredTools) {
      const name = (tool as { name: string }).name;
      if (this.discoveredNames.has(name) && !resolvedTools[name]) {
        resolvedTools[name] = tool;
      }
    }

    return {
      messages: res.messages,
      recalled: res.recalled,
      strategyUsed: res.strategyUsed,
      fallback: res.fallback,
      tokenEstimate: res.tokenEstimate,
      conversationMessages: res.conversationMessages,
      totalMessages: res.totalMessages,
      includedMessages: res.includedMessages,
      tools: resolvedTools,
      summary: res.summary,
    };
  }
}
