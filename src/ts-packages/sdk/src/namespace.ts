import type { ApiClient } from "./api-client.js";
import { Session } from "./session.js";
import type { AgentifiedTool } from "./types.js";

export class Namespace {
  /** Stub — namespace-scoped tools (recall, preferences, etc.) will be added later. */
  readonly tools: Record<string, unknown> = {};

  constructor(
    readonly id: string,
    /** @internal */ private readonly sdk: ApiClient,
    /** @internal */ private readonly datasetId: string,
    /** @internal */ private readonly registeredTools: AgentifiedTool[],
  ) {}

  session(id: string): Session {
    return new Session(id, this.id, this.sdk, this.datasetId, this.registeredTools);
  }
}
