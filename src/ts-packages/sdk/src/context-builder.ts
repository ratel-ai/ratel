import type { ApiClient } from "./api-client.js";
import type { AgentifiedTool, AssembledContext, CompactionStrategy, ContextStrategy, RecallConfig, StoredMessage } from "./types.js";

export class ContextBuilder<T = AgentifiedTool> {
  private messageOpts: { strategy?: ContextStrategy; maxTokens?: number; keepFirst?: boolean; pruneThreshold?: number; compactionStrategy?: CompactionStrategy } = {};
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

  messages(opts: { strategy?: ContextStrategy; maxTokens?: number; keepFirst?: boolean; pruneThreshold?: number; compactionStrategy?: CompactionStrategy }): this {
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
    const { compactionStrategy } = this.messageOpts;
    const isClientCompaction = compactionStrategy && this.messageOpts.strategy === "compacted";

    const res = await this.sdk.getContext(this.datasetId, this.namespaceId, this.sessionId, {
      strategy: isClientCompaction ? "recent" : this.messageOpts.strategy,
      maxTokens: this.messageOpts.maxTokens,
      keepFirst: this.messageOpts.keepFirst,
      pruneThreshold: this.messageOpts.pruneThreshold,
      recall: this.recallOpts,
      limitTokens: this.tokenLimit,
    });

    // Client-side compaction: fetch all messages, find older ones, call user's compactionStrategy
    if (isClientCompaction) {
      const allMsgs = await this.sdk.getMessages(this.datasetId, this.namespaceId, this.sessionId, {});
      const recentSeqs = new Set(res.messages.map(m => m.seq));
      const olderMessages = allMsgs.messages.filter(m => !recentSeqs.has(m.seq));

      if (olderMessages.length > 0) {
        const { summary } = await compactionStrategy(olderMessages);
        const firstSeq = olderMessages[0]!.seq;
        const lastSeq = olderMessages[olderMessages.length - 1]!.seq;
        res.summary = summary;
        res.summaryRange = { firstSeq, lastSeq, count: olderMessages.length };
        res.strategyUsed = "compacted";
      }
    }

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
