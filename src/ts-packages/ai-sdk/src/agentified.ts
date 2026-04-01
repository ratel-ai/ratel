import { tool, type Tool } from "ai";
import { z } from "zod";
import type {
  Agentified,
  Instance,
  DatasetRef,
  Session,
  Namespace,
  DiscoverTool,
  GetMessagesTool,
  BackendTool,
  RegisterInput,
  GetMessagesOptions,
  ContextBuilder,
  AssembledContext,
  CompactionStrategy,
  ContextStrategy,
  RecallConfig,
} from "agentified";
import { jsonSchemaToZod } from "./schema.js";

// --- Types ---

type AiSdkTool = Tool;

// --- AiSdkAssembledContext ---

export class AiSdkAssembledContext {
  constructor(
    private readonly sdkCtx: AssembledContext,
    readonly tools: Record<string, AiSdkTool>,
    private readonly sdkPrepareStep: Session["prepareStep"],
  ) {}

  get messages() { return this.sdkCtx.messages; }
  get recalled() { return this.sdkCtx.recalled; }
  get strategyUsed() { return this.sdkCtx.strategyUsed; }
  get fallback() { return this.sdkCtx.fallback; }
  get tokenEstimate() { return this.sdkCtx.tokenEstimate; }
  get conversationMessages() { return this.sdkCtx.conversationMessages; }
  get totalMessages() { return this.sdkCtx.totalMessages; }
  get includedMessages() { return this.sdkCtx.includedMessages; }
  get summary() { return this.sdkCtx.summary; }

  readonly prepareStep = async (params: { stepNumber: number; steps: any[] }) => {
    const result = await this.sdkPrepareStep(params);
    return { activeTools: result.activeTools };
  };

  async flushMessages(steps: any[]): Promise<void> {
    await this.sdkPrepareStep({ stepNumber: steps.length, steps });
  }
}

// --- AiSdkContextBuilder ---

export class AiSdkContextBuilder {
  private explicitTools: Record<string, AiSdkTool> = {};

  constructor(
    private readonly sdkBuilder: ContextBuilder,
    private readonly sdkPrepareStep: Session["prepareStep"],
    private readonly discoverAiSdkTool: AiSdkTool,
    private readonly discoveredNames: Set<string>,
    private readonly aiSdkToolCache: Record<string, AiSdkTool>,
  ) {}

  tools(tools: Record<string, AiSdkTool>): this {
    Object.assign(this.explicitTools, tools);
    return this;
  }

  messages(opts: { strategy?: ContextStrategy; maxTokens?: number; keepFirst?: boolean; pruneThreshold?: number; compactionStrategy?: CompactionStrategy }): this {
    this.sdkBuilder.messages(opts);
    return this;
  }

  recall(opts?: RecallConfig): this {
    this.sdkBuilder.recall(opts);
    return this;
  }

  limitTokens(budget: number): this {
    this.sdkBuilder.limitTokens(budget);
    return this;
  }

  async assemble(): Promise<AiSdkAssembledContext> {
    const sdkCtx = await this.sdkBuilder.assemble();

    // AI SDK requires all tools upfront; prepareStep controls visibility via activeTools
    const resolvedTools: Record<string, AiSdkTool> = {
      ...this.aiSdkToolCache,
      ...this.explicitTools,
    };

    return new AiSdkAssembledContext(sdkCtx, resolvedTools, this.sdkPrepareStep);
  }
}

// --- Factory ---

export function aiSdk() {
  return { adapt: (ag: Agentified) => new AiSdkAgentified(ag) };
}

// --- Typed shells (composition, not inheritance) ---

export class AiSdkAgentified {
  constructor(private readonly ag: Agentified) {}

  connect(url?: string, options?: { headers?: Record<string, string> }) { return this.ag.connect(url, options); }
  disconnect() { return this.ag.disconnect(); }

  dataset(name: string) { return new AiSdkDatasetRef(this.ag.dataset(name)); }

  async register(input: RegisterInput) {
    const backendTools = extractBackendTools(input.tools);
    return new AiSdkInstance(await this.ag.register(input), backendTools);
  }
}

export class AiSdkDatasetRef {
  constructor(private readonly ref: DatasetRef) {}

  async register(input: RegisterInput) {
    const backendTools = extractBackendTools(input.tools);
    return new AiSdkInstance(await this.ref.register(input), backendTools);
  }
}

export class AiSdkInstance {
  readonly discoverTool: AiSdkTool;
  readonly tools: Record<string, AiSdkTool>;
  private readonly aiSdkToolCache: Record<string, AiSdkTool>;

  get instanceId() { return this.inst.instanceId; }
  get datasetId() { return this.inst.datasetId; }

  constructor(
    private readonly inst: Instance,
    private readonly backendTools: BackendTool[],
  ) {
    this.discoverTool = wrapDiscoverTool(inst.discoverTool);
    this.aiSdkToolCache = buildAiSdkToolMap(backendTools);
    this.tools = {
      ...this.aiSdkToolCache,
      agentified_discover: this.discoverTool,
    };
  }

  readonly prepareStep = async (params: { stepNumber: number; steps: any[] }) => {
    const result = await this.inst.prepareStep(params);
    return { activeTools: result.activeTools };
  };

  session(id: string) { return new AiSdkSession(this.inst.session(id), this.backendTools); }
  namespace(id: string) { return new AiSdkNamespace(this.inst.namespace(id), this.backendTools); }
}

export class AiSdkSession {
  readonly discoverTool: AiSdkTool;
  readonly getMessagesTool: AiSdkTool;
  readonly tools: Record<string, AiSdkTool>;
  private readonly aiSdkToolCache: Record<string, AiSdkTool>;

  get id() { return this.sess.id; }
  get conversation() { return this.sess.conversation; }

  constructor(
    private readonly sess: Session,
    private readonly backendTools: BackendTool[],
  ) {
    this.discoverTool = wrapDiscoverTool(sess.discoverTool);
    this.getMessagesTool = wrapGetMessagesTool(sess.getMessagesTool);
    this.aiSdkToolCache = buildAiSdkToolMap(backendTools);
    this.tools = {
      ...this.aiSdkToolCache,
      agentified_discover: this.discoverTool,
      agentified_get_messages: this.getMessagesTool,
    };
  }

  get context(): AiSdkContextBuilder {
    return new AiSdkContextBuilder(
      this.sess.context,
      this.sess.prepareStep,
      this.discoverTool,
      this.sess.discoverTool.discoveredNames,
      this.aiSdkToolCache,
    );
  }

  readonly prepareStep = async (params: { stepNumber: number; steps: any[] }) => {
    const result = await this.sess.prepareStep(params);
    return { activeTools: result.activeTools };
  };

  async flushMessages(steps: any[]): Promise<void> {
    await this.sess.prepareStep({ stepNumber: steps.length, steps });
  }

  getMessages(opts?: GetMessagesOptions) { return this.sess.getMessages(opts); }
  updateConversation(input: { messages: Array<{ role: string; content: string }> }) {
    return this.sess.updateConversation(input);
  }
}

export class AiSdkNamespace {
  constructor(
    private readonly ns: Namespace,
    private readonly backendTools: BackendTool[],
  ) {}

  get id() { return this.ns.id; }

  session(id: string) { return new AiSdkSession(this.ns.session(id), this.backendTools); }
}

// --- Helpers ---

function extractBackendTools(tools: RegisterInput["tools"]): BackendTool[] {
  return tools.filter(
    (t): t is BackendTool => !("type" in t) || t.type === "backend",
  );
}

function wrapGetMessagesTool(gmt: GetMessagesTool): AiSdkTool {
  return tool({
    description: gmt.definition.description,
    inputSchema: z.object({
      limit: z.number().optional(),
      afterSeq: z.number().optional(),
      aroundSeq: z.number().optional(),
    }),
    execute: async (input: { limit?: number; afterSeq?: number; aroundSeq?: number }) => gmt.execute(input),
  });
}

function wrapDiscoverTool(dt: DiscoverTool): AiSdkTool {
  return tool({
    description: dt.definition.description,
    inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
    execute: async (input: { query: string; limit?: number }) => dt.execute(input),
  });
}

function buildAiSdkToolMap(backendTools: BackendTool[]): Record<string, AiSdkTool> {
  const tools: Record<string, AiSdkTool> = {};
  for (const t of backendTools) {
    tools[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchemaToZod(t.parameters),
      execute: async (inputData) => t.handler(inputData as Record<string, unknown>),
    });
  }
  return tools;
}
