import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type {
  Agentified,
  Instance,
  DatasetRef,
  Session,
  Namespace,
  DiscoverTool,
  DiscoverToolInput,
  RegisterInput,
  PrepareStepFn,
  GetMessagesOptions,
} from "agentified";

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
    return new MastraInstance(await this.ag.register(input));
  }
}

export class MastraDatasetRef {
  constructor(private readonly ref: DatasetRef) {}

  async register(input: RegisterInput) {
    return new MastraInstance(await this.ref.register(input));
  }
}

export class MastraInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly discoverTool: any;
  readonly prepareStep: PrepareStepFn;

  get instanceId() { return this.inst.instanceId; }
  get datasetId() { return this.inst.datasetId; }

  constructor(private readonly inst: Instance) {
    this.discoverTool = wrapDiscoverTool(inst.discoverTool);
    this.prepareStep = inst.prepareStep;
  }

  session(id: string) { return new MastraSession(this.inst.session(id)); }
  namespace(id: string) { return new MastraNamespace(this.inst.namespace(id)); }
}

export class MastraSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly discoverTool: any;
  readonly prepareStep: PrepareStepFn;

  get id() { return this.sess.id; }
  get context() { return this.sess.context; }
  get conversation() { return this.sess.conversation; }

  constructor(private readonly sess: Session) {
    this.discoverTool = wrapDiscoverTool(sess.discoverTool);
    this.prepareStep = sess.prepareStep;
  }

  getMessages(opts?: GetMessagesOptions) { return this.sess.getMessages(opts); }
  updateConversation(input: { messages: Array<{ role: string; content: string }> }) {
    return this.sess.updateConversation(input);
  }
}

export class MastraNamespace {
  constructor(private readonly ns: Namespace) {}

  get id() { return this.ns.id; }

  session(id: string) { return new MastraSession(this.ns.session(id)); }
}

// --- Converter ---

function wrapDiscoverTool(dt: DiscoverTool) {
  return createTool({
    id: dt.definition.name,
    description: dt.definition.description,
    inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
    execute: async (input: { query: string; limit?: number }) => dt.execute(input),
  });
}
