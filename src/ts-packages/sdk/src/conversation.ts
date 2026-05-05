import type { ApiClient } from "./api-client.js";
import type { AppendMessagesResponse, GetMessagesOpts, StoredMessage } from "./types.js";

export class Conversation {
  constructor(
    private readonly sdk: ApiClient,
    private readonly datasetId: string,
    private readonly namespaceId: string,
    private readonly sessionId: string,
  ) {}

  async append(messages: Array<{ role: string; content: string }>): Promise<AppendMessagesResponse> {
    return this.sdk.appendMessages(this.datasetId, this.namespaceId, this.sessionId, messages);
  }

  async messages(opts?: GetMessagesOpts): Promise<StoredMessage[]> {
    const res = await this.sdk.getMessages(this.datasetId, this.namespaceId, this.sessionId, opts);
    return res.messages;
  }
}
