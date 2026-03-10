import type { ApiClient } from "./api-client.js";
import type { AssembledContext } from "./types.js";

export class ContextBuilder {
  private messageOpts: { strategy?: string; maxTokens?: number } = {};

  constructor(
    private readonly sdk: ApiClient,
    private readonly datasetId: string,
    private readonly namespaceId: string,
    private readonly sessionId: string,
  ) {}

  messages(opts: { strategy?: string; maxTokens?: number }): this {
    this.messageOpts = opts;
    return this;
  }

  recall(_opts?: unknown): this {
    return this;
  }

  async build(): Promise<AssembledContext> {
    const res = await this.sdk.getContext(this.datasetId, this.namespaceId, this.sessionId, {
      strategy: this.messageOpts.strategy,
      maxTokens: this.messageOpts.maxTokens,
    });
    return {
      messages: res.messages,
      recalled: res.recalled,
      strategyUsed: res.strategyUsed,
      fallback: res.fallback,
      tokenEstimate: res.tokenEstimate,
      conversationMessages: res.conversationMessages,
      totalMessages: res.totalMessages,
      includedMessages: res.includedMessages,
    };
  }
}
