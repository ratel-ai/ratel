import { ApiClient, type DiscoverToolInput, type StoredMessage, type ContextResponse, type AppendMessagesResponse, type GetMessagesOpts as SdkGetMessagesOpts } from "@agentified/sdk";
import { createTool } from "@mastra/core/tools";
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { resolveBinaryPath, findFreePort } from "./spawn-utils.js";

export interface BackendTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  type?: "backend";
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ClientTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  type: "client";
}

export interface McpTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  type: "mcp";
  server: string;
}

export type AgentifiedTool = BackendTool | ClientTool | McpTool;

export type PrepareStepFn = (params: {
  stepNumber: number;
  steps: any[];
}) => Promise<{ activeTools: string[] }>;

export interface AssembledContext {
  messages: StoredMessage[];
  recalled: { tools: unknown[]; memories: unknown[] };
  strategyUsed: string;
  fallback: boolean;
  tokenEstimate: number;
  conversationMessages: number;
  totalMessages: number;
  includedMessages: number;
}

export interface GetMessagesOptions {
  maxMessages?: number;
  maxTokens?: number;
  strategy?: string;
}

export interface GetMessagesResult {
  messages: StoredMessage[];
  totalMessages: number;
  includedMessages: number;
  strategyUsed: string;
  fallback: boolean;
}

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

  async assemble(): Promise<AssembledContext> {
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

  async messages(opts?: SdkGetMessagesOpts): Promise<StoredMessage[]> {
    const res = await this.sdk.getMessages(this.datasetId, this.namespaceId, this.sessionId, opts);
    return res.messages;
  }
}

export class Session {
  private lastPersistedSeq = 0;
  private lastProcessedStepIndex = 0;

  readonly conversation: Conversation;

  constructor(
    readonly id: string,
    readonly namespaceId: string,
    /** @internal */ private readonly sdk: ApiClient,
    /** @internal */ private readonly datasetId: string,
    /** @internal */ private readonly toolNames: string[],
  ) {
    this.conversation = new Conversation(sdk, datasetId, namespaceId, id);
  }

  get context(): ContextBuilder {
    return new ContextBuilder(this.sdk, this.datasetId, this.namespaceId, this.id);
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
    const activeTools = new Set([...this.toolNames, "agentified_discover"]);

    // Only process steps we haven't seen yet
    const newSteps = steps.slice(this.lastProcessedStepIndex);

    // Extract messages from new steps for persistence
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
          messages.push({
            role: "tool",
            content: typeof result.result === "string" ? result.result : JSON.stringify(result.result),
            tool_call_id: result.toolCallId,
          });
        }
      }
    }

    // Persist if there are new messages
    if (messages.length > 0) {
      const res = await this.sdk.appendMessages(this.datasetId, this.namespaceId, this.id, messages);
      this.lastPersistedSeq = res.lastSeq;
    }

    this.lastProcessedStepIndex = steps.length;

    // Scan ALL steps for discovered tools (need full history for active set)
    for (const step of steps) {
      if (step.toolResults) {
        for (const result of step.toolResults) {
          if (result.toolName === "agentified_discover" && Array.isArray(result.result)) {
            for (const tool of result.result) {
              if (tool.name) activeTools.add(tool.name);
            }
          }
        }
      }
    }

    return { activeTools: [...activeTools] };
  };

  async updateConversation(input: { messages: Array<{ role: string; content: string }> }): Promise<void> {
    const { messages } = input;
    if (messages.length === 0) return;

    const stored = await this.sdk.getMessages(this.datasetId, this.namespaceId, this.id, { limit: messages.length });
    const tail = stored.messages;

    // Find longest suffix of stored tail that matches a contiguous slice of incoming.
    // Stored tail represents the last N messages in DB. We compare it against
    // the END of incoming to find overlap, avoiding duplicates when stored
    // tail=[c,d,e] and incoming=[d,e,f].
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

export interface RegisterInput {
  tools: AgentifiedTool[];
}

export class Instance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly discoverTool: any;

  constructor(
    readonly instanceId: string,
    readonly datasetId: string,
    /** @internal */ private readonly sdk: ApiClient,
    /** @internal */ private readonly toolNames: string[],
  ) {
    const discoverDef = sdk.asDiscoverTool(datasetId);
    this.discoverTool = createTool({
      id: "agentified_discover",
      description: discoverDef.definition.description,
      inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
      execute: async (input) => {
        return discoverDef.execute(input as DiscoverToolInput);
      },
    });
  }

  readonly prepareStep: PrepareStepFn = async ({ steps }) => {
    const activeTools = new Set([...this.toolNames, "agentified_discover"]);

    for (const step of steps) {
      if (step.toolResults) {
        for (const result of step.toolResults) {
          if (result.toolName === "agentified_discover" && Array.isArray(result.result)) {
            for (const tool of result.result) {
              if (tool.name) activeTools.add(tool.name);
            }
          }
        }
      }
    }

    return { activeTools: [...activeTools] };
  };

  session(id: string): Session {
    return new Session(id, "default", this.sdk, this.datasetId, this.toolNames);
  }
}

function validateTools(tools: AgentifiedTool[]): void {
  for (const tool of tools) {
    if ("type" in tool && tool.type === "client") {
      throw new Error("Client tools are not yet supported");
    }
    if ("type" in tool && tool.type === "mcp") {
      throw new Error("MCP tools are not yet supported");
    }
    if (!("handler" in tool)) {
      throw new Error(`Tool '${(tool as { name: string }).name}' has no type and no handler`);
    }
  }
}

export class DatasetRef {
  constructor(
    readonly agentified: Agentified,
    readonly datasetName: string,
  ) {}

  async register(input: RegisterInput): Promise<Instance> {
    validateTools(input.tools);

    const sdk = this.agentified.sdk;
    if (!sdk) throw new Error("Not connected");

    const serverTools = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const regSdk = new ApiClient({
      serverUrl: this.agentified.serverUrl!,
      tools: serverTools,
    });
    await regSdk.register(this.datasetName);

    const toolNames = input.tools.map((t) => t.name);
    return new Instance(this.datasetName, this.datasetName, sdk, toolNames);
  }
}

export class Agentified {
  /** @internal */ sdk: ApiClient | null = null;
  /** @internal */ serverUrl: string | null = null;
  private connected = false;
  private spawnedProcess: ChildProcess | null = null;
  private cleanupHandlers: Array<[string, (...args: any[]) => void]> = [];
  private restartCount = 0;
  private lastRestartAt = 0;
  private spawnArgs: { binaryPath: string; port: number } | null = null;

  async connect(serverUrl?: string): Promise<void> {
    if (!serverUrl) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY environment variable is required for local spawn");
      }
      const binaryPath = resolveBinaryPath();
      if (!binaryPath) {
        throw new Error("Could not resolve agentified core binary. Install the platform-specific package.");
      }

      const port = await findFreePort();
      this.spawnArgs = { binaryPath, port };
      this.spawnChild();

      const url = `http://127.0.0.1:${port}`;
      await this.healthCheckLoop(url);

      this.registerCleanupHandlers();
      this.registerCrashHandler();

      this.serverUrl = url;
      this.sdk = new ApiClient({ serverUrl: url, tools: [] });
      this.connected = true;
      return;
    }

    const res = await fetch(`${serverUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status}`);
    }

    this.serverUrl = serverUrl;
    this.sdk = new ApiClient({ serverUrl, tools: [] });
    this.connected = true;
  }

  dataset(name: string): DatasetRef {
    return new DatasetRef(this, name);
  }

  async register(input: RegisterInput): Promise<Instance> {
    return this.dataset("default").register(input);
  }

  private spawnChild(): void {
    if (!this.spawnArgs) return;
    const { binaryPath, port } = this.spawnArgs;
    const child = spawn(binaryPath, [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENTIFIED_PORT: String(port) },
    });
    this.spawnedProcess = child;
  }

  private registerCrashHandler(): void {
    if (!this.spawnedProcess) return;
    this.spawnedProcess.on("exit", (code, signal) => {
      if (!this.connected) return; // intentional shutdown
      const now = Date.now();
      if (this.restartCount >= 1 || now - this.lastRestartAt < 60_000) return;
      this.restartCount++;
      this.lastRestartAt = now;
      this.spawnChild();
      this.registerCrashHandler();
    });
  }

  private registerCleanupHandlers(): void {
    const cleanup = () => {
      if (this.spawnedProcess) {
        this.spawnedProcess.kill("SIGTERM");
        const child = this.spawnedProcess;
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, 2000);
        this.spawnedProcess = null;
      }
    };

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => { cleanup(); process.exit(); };
      process.on(sig, handler);
      this.cleanupHandlers.push([sig, handler]);
    }

    const exitHandler = () => { cleanup(); };
    process.on("exit", exitHandler);
    this.cleanupHandlers.push(["exit", exitHandler]);
  }

  private removeCleanupHandlers(): void {
    for (const [event, handler] of this.cleanupHandlers) {
      process.removeListener(event, handler);
    }
    this.cleanupHandlers = [];
  }

  /** @internal */ healthCheckDelayMs = 200;
  /** @internal */ healthCheckMaxAttempts = 25;

  private async healthCheckLoop(url: string): Promise<void> {
    for (let i = 0; i < this.healthCheckMaxAttempts; i++) {
      try {
        const res = await fetch(`${url}/health`);
        if (res.ok) return;
      } catch {
        // server not ready yet
      }
      await new Promise((r) => setTimeout(r, this.healthCheckDelayMs));
    }
    if (this.spawnedProcess) {
      this.spawnedProcess.kill();
      this.spawnedProcess = null;
    }
    throw new Error("Local server failed to start within 5s");
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;

    if (this.spawnedProcess) {
      this.spawnedProcess.kill();
      this.spawnedProcess = null;
    }

    this.removeCleanupHandlers();
    this.sdk = null;
    this.serverUrl = null;
    this.connected = false;
  }
}
