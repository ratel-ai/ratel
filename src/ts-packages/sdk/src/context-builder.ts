import type { ApiClient } from "./api-client.js";
import type { AgentifiedTool, AssembledContext, ContextStrategy, RecallConfig, StoredMessage } from "./types.js";

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

    // Construct summary message and inject into messages array
    let finalMessages: StoredMessage[] = res.messages;
    if (res.summary && res.summaryRange) {
      const { firstSeq, lastSeq, count } = res.summaryRange;
      const summaryMsg: StoredMessage = {
        id: "summary",
        role: "assistant",
        content: `[Summary of messages ${firstSeq}\u2013${lastSeq} (${count} messages compacted)]\n${res.summary}`,
        createdAt: "",
        seq: 0,
      };
      // Place after keepFirst message (first user msg at position 0) if present
      const firstUserIdx = finalMessages.findIndex(m => m.role === "user");
      if (firstUserIdx === 0 && finalMessages.length > 0) {
        finalMessages = [finalMessages[0]!, summaryMsg, ...finalMessages.slice(1)];
      } else {
        finalMessages = [summaryMsg, ...finalMessages];
      }
    }

    const resolvedTools: Record<string, T> = { ...this.explicitTools };
    for (const tool of this.registeredTools) {
      const name = (tool as { name: string }).name;
      if (this.discoveredNames.has(name) && !resolvedTools[name]) {
        resolvedTools[name] = tool;
      }
    }

    return {
      messages: finalMessages,
      recalled: res.recalled,
      strategyUsed: res.strategyUsed,
      fallback: res.fallback,
      tokenEstimate: res.tokenEstimate,
      conversationMessages: res.conversationMessages,
      totalMessages: res.totalMessages,
      includedMessages: res.includedMessages,
      tools: resolvedTools,
      summary: res.summary,
      summaryRange: res.summaryRange,
    };
  }
}
