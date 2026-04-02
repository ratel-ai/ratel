import type { ApiClient } from "./api-client.js";
import { ContextBuilder } from "./context-builder.js";
import { Conversation } from "./conversation.js";
import type { AgentifiedTool, GetMessagesTool, GetMessagesOptions, GetMessagesResult, PrepareStepFn } from "./types.js";

export class Session {
  private lastPersistedSeq = 0;
  private lastProcessedStepIndex = 0;
  private readonly _discoverTool;
  private _getMessagesTool?: GetMessagesTool;

  readonly conversation: Conversation;

  constructor(
    readonly id: string,
    readonly namespaceId: string,
    /** @internal */ private readonly sdk: ApiClient,
    /** @internal */ private readonly datasetId: string,
    /** @internal */ private readonly registeredTools: AgentifiedTool[],
  ) {
    this.conversation = new Conversation(sdk, datasetId, namespaceId, id);
    this._discoverTool = sdk.asDiscoverTool(datasetId, namespaceId, id);
  }

  get context(): ContextBuilder {
    return new ContextBuilder(
      this.sdk, this.datasetId, this.namespaceId, this.id,
      this.registeredTools,
      this._discoverTool.discoveredNames,
    );
  }

  get discoverTool() {
    return this._discoverTool;
  }

  get getMessagesTool(): GetMessagesTool {
    if (!this._getMessagesTool) {
      this._getMessagesTool = this.sdk.asGetMessagesTool(this.datasetId, this.namespaceId, this.id);
    }
    return this._getMessagesTool;
  }

  async getMessages(opts?: GetMessagesOptions): Promise<GetMessagesResult> {
    const res = await this.sdk.getContext(this.datasetId, this.namespaceId, this.id, {
      strategy: opts?.strategy,
      maxTokens: opts?.maxTokens,
    });
    let messages = res.messages;
    let includedMessages = res.includedMessages;
    if (opts?.maxMessages && messages.length > opts.maxMessages) {
      messages = messages.slice(messages.length - opts.maxMessages);
      includedMessages = messages.length;
    }
    return {
      messages,
      totalMessages: res.totalMessages,
      includedMessages,
      strategyUsed: res.strategyUsed,
      fallback: res.fallback,
    };
  }

  readonly prepareStep: PrepareStepFn = async ({ steps }) => {
    const activeTools = new Set(["agentified_discover", "agentified_get_messages"]);

    const newSteps = steps.slice(this.lastProcessedStepIndex);

    const messages: Array<{ role: string; content: string; tool_calls?: unknown; tool_call_id?: string }> = [];
    for (const step of newSteps) {
      if (step.text) {
        messages.push({ role: "assistant", content: step.text });
      }
      if (step.toolCalls && step.toolCalls.length > 0) {
        messages.push({ role: "assistant", content: "", tool_calls: step.toolCalls });
      }
      if (step.toolResults) {
        for (const result of step.toolResults) {
          const raw = result.result;
          const content = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "";
          messages.push({ role: "tool", content, tool_call_id: result.toolCallId });
        }
      }
    }

    if (messages.length > 0) {
      const res = await this.sdk.appendMessages(this.datasetId, this.namespaceId, this.id, messages);
      this.lastPersistedSeq = res.lastSeq;
    }

    this.lastProcessedStepIndex = steps.length;

    for (const name of this._discoverTool.discoveredNames) activeTools.add(name);

    return { activeTools: [...activeTools] };
  };

  async updateConversation(input: { messages: Array<{ role: string; content: string }> }): Promise<void> {
    const { messages } = input;
    if (messages.length === 0) return;

    const stored = await this.sdk.getMessages(this.datasetId, this.namespaceId, this.id, { limit: messages.length });
    const tail = stored.messages;

    let overlap = 0;
    for (let tryLen = Math.min(tail.length, messages.length); tryLen > 0; tryLen--) {
      const tailStart = tail.length - tryLen;
      let match = true;
      for (let i = 0; i < tryLen; i++) {
        if (tail[tailStart + i]!.role !== messages[i]!.role || tail[tailStart + i]!.content !== messages[i]!.content) {
          match = false;
          break;
        }
      }
      if (match) {
        overlap = tryLen;
        break;
      }
    }

    const newMessages = messages.slice(overlap);
    if (newMessages.length === 0) return;

    const res = await this.sdk.appendMessages(this.datasetId, this.namespaceId, this.id, newMessages);
    this.lastPersistedSeq = res.lastSeq;
  }
}
