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
} from "agentified";
import { jsonSchemaToZod } from "./schema.js";

// --- Types ---

type MastraTool = ReturnType<typeof createTool>;

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

  prepareStep(opts?: { tools: Record<string, MastraTool> }) {
    const baseTools: Record<string, MastraTool> = opts?.tools ?? { agentified_discover: this.discoverTool };
    return async (params: { stepNumber: number; steps: any[] }) => {
      await this.inst.prepareStep(params);
      const tools: Record<string, MastraTool> = { ...baseTools };
      for (const name of this.inst.discoverTool.discoveredNames) {
        if (!tools[name] && this.mastraToolCache[name]) {
          tools[name] = this.mastraToolCache[name];
        }
      }
      return { tools };
    };
  }

  session(id: string) { return new MastraSession(this.inst.session(id), this.backendTools); }
  namespace(id: string) { return new MastraNamespace(this.inst.namespace(id), this.backendTools); }
}

export class MastraSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly discoverTool: any;
  private readonly mastraToolCache: Record<string, MastraTool>;

  get id() { return this.sess.id; }
  get context() { return this.sess.context; }
  get conversation() { return this.sess.conversation; }

  constructor(
    private readonly sess: Session,
    private readonly backendTools: BackendTool[],
  ) {
    this.discoverTool = wrapDiscoverTool(sess.discoverTool);
    this.mastraToolCache = buildMastraToolMap(backendTools);
  }

  prepareStep(opts?: { tools: Record<string, MastraTool> }) {
    const baseTools: Record<string, MastraTool> = opts?.tools ?? { agentified_discover: this.discoverTool };
    return async (params: { stepNumber: number; steps: any[] }) => {
      await this.sess.prepareStep(params);
      const tools: Record<string, MastraTool> = { ...baseTools };
      for (const name of this.sess.discoverTool.discoveredNames) {
        if (!tools[name] && this.mastraToolCache[name]) {
          tools[name] = this.mastraToolCache[name];
        }
      }
      return { tools };
    };
  }

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
