import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type {
  Agentified,
  Instance,
  DatasetRef,
  Session,
  Namespace,
  DiscoverTool,
  BackendTool,
  RegisterInput,
  GetMessagesOptions,
  ContextBuilder,
  AssembledContext,
  ContextStrategy,
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
  ) {}

  tools(tools: Record<string, MastraTool>): this {
    Object.assign(this.explicitTools, tools);
    return this;
  }

  messages(opts: { strategy?: ContextStrategy; maxTokens?: number }): this {
    this.sdkBuilder.messages(opts);
    return this;
  }

  recall(opts?: unknown): this {
    this.sdkBuilder.recall(opts);
    return this;
  }

  async assemble(): Promise<MastraAssembledContext> {
    const sdkCtx = await this.sdkBuilder.assemble();

    const resolvedTools: Record<string, MastraTool> = { ...this.explicitTools };
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

  connect(url?: string) { return this.ag.connect(url); }
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

  constructor(
    private readonly inst: Instance,
    private readonly backendTools: BackendTool[],
  ) {
    this.discoverTool = wrapDiscoverTool(inst.discoverTool);
    this.mastraToolCache = buildMastraToolMap(backendTools);
  }

  readonly prepareStep = async (params: { stepNumber: number; steps: any[] }) => {
    await this.inst.prepareStep(params);
    const tools: Record<string, MastraTool> = { agentified_discover: this.discoverTool };
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
  private readonly mastraToolCache: Record<string, MastraTool>;

  get id() { return this.sess.id; }
  get conversation() { return this.sess.conversation; }

  constructor(
    private readonly sess: Session,
    private readonly backendTools: BackendTool[],
  ) {
    this.discoverTool = wrapDiscoverTool(sess.discoverTool);
    this.mastraToolCache = buildMastraToolMap(backendTools);
  }

  get context(): MastraContextBuilder {
    return new MastraContextBuilder(
      this.sess.context,
      this.sess.prepareStep,
      this.discoverTool,
      this.sess.discoverTool.discoveredNames,
      this.mastraToolCache,
    );
  }

  readonly prepareStep = async (params: { stepNumber: number; steps: any[] }) => {
    await this.sess.prepareStep(params);
    const tools: Record<string, MastraTool> = { agentified_discover: this.discoverTool };
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

function wrapDiscoverTool(dt: DiscoverTool) {
  return createTool({
    id: dt.definition.name,
    description: dt.definition.description,
    inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
    execute: async (input: { query: string; limit?: number }) => dt.execute(input),
  });
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
