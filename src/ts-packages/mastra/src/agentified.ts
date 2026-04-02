import { createTool } from "@mastra/core/tools";
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
  AgentifiedTool,
} from "agentified";
import { jsonSchemaToZod } from "./schema.js";

// --- Types ---

type MastraTool = ReturnType<typeof createTool>;

// --- MastraAssembledContext ---

export class MastraAssembledContext {
  constructor(
    private readonly sdkCtx: AssembledContext,
    readonly tools: Record<string, MastraTool>,
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
    await this.sdkPrepareStep(params);
    return { tools: this.tools };
  };
}

// --- MastraContextBuilder ---

export class MastraContextBuilder {
  private explicitTools: Record<string, MastraTool> = {};

  constructor(
    private readonly sdkBuilder: ContextBuilder,
    private readonly sdkPrepareStep: Session["prepareStep"],
    private readonly discoverMastraTool: MastraTool,
    private readonly discoveredNames: Set<string>,
    private readonly mastraToolCache: Record<string, MastraTool>,
    private readonly alwaysIncludeNames: Set<string> = new Set(),
  ) {}

  tools(tools: Record<string, MastraTool>): this {
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

  async assemble(): Promise<MastraAssembledContext> {
    const sdkCtx = await this.sdkBuilder.assemble();

    const resolvedTools: Record<string, MastraTool> = { ...this.explicitTools };
    for (const name of this.alwaysIncludeNames) {
      if (!resolvedTools[name] && this.mastraToolCache[name]) {
        resolvedTools[name] = this.mastraToolCache[name];
      }
    }
    for (const name of this.discoveredNames) {
      if (!resolvedTools[name] && this.mastraToolCache[name]) {
        resolvedTools[name] = this.mastraToolCache[name];
      }
    }

    return new MastraAssembledContext(sdkCtx, resolvedTools, this.sdkPrepareStep);
  }
}

// --- Factory ---

export function mastra() {
  return { adapt: (ag: Agentified) => new MastraAgentified(ag) };
}

// --- Typed shells (composition, not inheritance) ---

export class MastraAgentified {
  constructor(private readonly ag: Agentified) {}

  connect(url?: string, options?: { headers?: Record<string, string> }) { return this.ag.connect(url, options); }
  disconnect() { return this.ag.disconnect(); }

  dataset(name: string) { return new MastraDatasetRef(this.ag.dataset(name)); }

  async register(input: RegisterInput) {
    const backendTools = extractBackendTools(input.tools);
    return new MastraInstance(await this.ag.register(input), backendTools);
  }
}

export class MastraDatasetRef {
  constructor(private readonly ref: DatasetRef) {}

  async register(input: RegisterInput) {
    const backendTools = extractBackendTools(input.tools);
    return new MastraInstance(await this.ref.register(input), backendTools);
  }
}

export class MastraInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly discoverTool: any;
  private readonly mastraToolCache: Record<string, MastraTool>;

  get instanceId() { return this.inst.instanceId; }
  get datasetId() { return this.inst.datasetId; }

  private readonly alwaysIncludeNames: Set<string>;

  constructor(
    private readonly inst: Instance,
    private readonly backendTools: BackendTool[],
  ) {
    this.discoverTool = wrapDiscoverTool(inst.discoverTool);
    this.mastraToolCache = buildMastraToolMap(backendTools);
    this.alwaysIncludeNames = extractAlwaysIncludeNames(backendTools);
  }

  readonly prepareStep = async (params: { stepNumber: number; steps: any[] }) => {
    await this.inst.prepareStep(params);
    const tools: Record<string, MastraTool> = { agentified_discover: this.discoverTool };
    for (const name of this.alwaysIncludeNames) {
      if (this.mastraToolCache[name]) {
        tools[name] = this.mastraToolCache[name];
      }
    }
    for (const name of this.inst.discoverTool.discoveredNames) {
      if (!tools[name] && this.mastraToolCache[name]) {
        tools[name] = this.mastraToolCache[name];
      }
    }
    return { tools };
  };

  session(id: string) { return new MastraSession(this.inst.session(id), this.backendTools); }
  namespace(id: string) { return new MastraNamespace(this.inst.namespace(id), this.backendTools); }
}

export class MastraSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly discoverTool: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly getMessagesTool: any;
  private readonly mastraToolCache: Record<string, MastraTool>;

  get id() { return this.sess.id; }
  get conversation() { return this.sess.conversation; }

  private readonly alwaysIncludeNames: Set<string>;

  constructor(
    private readonly sess: Session,
    private readonly backendTools: BackendTool[],
  ) {
    this.discoverTool = wrapDiscoverTool(sess.discoverTool);
    this.getMessagesTool = wrapGetMessagesTool(sess.getMessagesTool);
    this.mastraToolCache = buildMastraToolMap(backendTools);
    this.alwaysIncludeNames = extractAlwaysIncludeNames(backendTools);
  }

  get context(): MastraContextBuilder {
    return new MastraContextBuilder(
      this.sess.context,
      this.sess.prepareStep,
      this.discoverTool,
      this.sess.discoverTool.discoveredNames,
      this.mastraToolCache,
      this.alwaysIncludeNames,
    );
  }

  readonly prepareStep = async (params: { stepNumber: number; steps: any[] }) => {
    await this.sess.prepareStep(params);
    const tools: Record<string, MastraTool> = {
      agentified_discover: this.discoverTool,
      agentified_get_messages: this.getMessagesTool,
    };
    for (const name of this.alwaysIncludeNames) {
      if (this.mastraToolCache[name]) {
        tools[name] = this.mastraToolCache[name];
      }
    }
    for (const name of this.sess.discoverTool.discoveredNames) {
      if (!tools[name] && this.mastraToolCache[name]) {
        tools[name] = this.mastraToolCache[name];
      }
    }
    return { tools };
  };

  getMessages(opts?: GetMessagesOptions) { return this.sess.getMessages(opts); }
  updateConversation(input: { messages: Array<{ role: string; content: string }> }) {
    return this.sess.updateConversation(input);
  }
}

export class MastraNamespace {
  constructor(
    private readonly ns: Namespace,
    private readonly backendTools: BackendTool[],
  ) {}

  get id() { return this.ns.id; }

  session(id: string) { return new MastraSession(this.ns.session(id), this.backendTools); }
}

// --- Helpers ---

function extractBackendTools(tools: RegisterInput["tools"]): BackendTool[] {
  return tools.filter(
    (t): t is BackendTool => !("type" in t) || t.type === "backend",
  );
}

function wrapGetMessagesTool(gmt: GetMessagesTool) {
  return createTool({
    id: gmt.definition.name,
    description: gmt.definition.description,
    inputSchema: z.object({
      limit: z.number().optional(),
      afterSeq: z.number().optional(),
      aroundSeq: z.number().optional(),
    }),
    execute: async (input: { limit?: number; afterSeq?: number; aroundSeq?: number }) => gmt.execute(input),
  });
}

function wrapDiscoverTool(dt: DiscoverTool) {
  return createTool({
    id: dt.definition.name,
    description: dt.definition.description,
    inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
    execute: async (input: { query: string; limit?: number }) => dt.execute(input),
  });
}

function extractAlwaysIncludeNames(backendTools: BackendTool[]): Set<string> {
  const names = new Set<string>();
  for (const t of backendTools) {
    if (t.alwaysInclude) names.add(t.name);
  }
  return names;
}

function buildMastraToolMap(backendTools: BackendTool[]): Record<string, MastraTool> {
  const tools: Record<string, MastraTool> = {};
  for (const t of backendTools) {
    tools[t.name] = createTool({
      id: t.name,
      description: t.description,
      inputSchema: jsonSchemaToZod(t.parameters),
      execute: async (inputData) => t.handler(inputData as Record<string, unknown>),
    }) as MastraTool;
  }
  return tools;
}
