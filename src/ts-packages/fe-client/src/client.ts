import type { AbstractAgent, BaseEvent, CustomEvent, Message, Context } from "@ag-ui/client";
import { HttpAgent, EventType, randomUUID } from "@ag-ui/client";
import type {
  AgentifiedClientConfig,
  CostConfig,
  CostMetrics,
  FrontendToolHandler,
  InspectorState,
  RegisteredSkill,
  ReliabilityIssue,
  SharedContext,
  SkillActivation,
  SkillSuggestion,
  StateListener,
  Subscription,
  ToolCallDetail,
} from "./types.js";
import { isAgentifiedEvent } from "./types.js";

const MAX_FRONTEND_TOOL_ITERATIONS = 5;

const DEFAULT_COST_CONFIG: CostConfig = {
  inputUsdPerMillion: 3,
  outputUsdPerMillion: 15,
  cachedUsdPerMillion: 0.3,
};

const SUGGESTION_MIN_COOCCURRENCE = 2;
const SUGGESTION_MIN_TOOLS = 2;

export class AgentifiedClient {
  private state: InspectorState;
  private listeners: Set<StateListener> = new Set();
  private agent: AbstractAgent;
  private pendingMessages: Map<string, { role: "assistant" | "user"; content: string }> = new Map();
  private frontendToolHandlers: Map<string, FrontendToolHandler> = new Map();
  private costConfig: CostConfig = DEFAULT_COST_CONFIG;
  private currentRunToolNames: Set<string> = new Set();
  private currentRunToolSignatures: Map<string, number> = new Map();
  private cooccurrencePatterns: Map<string, number> = new Map();

  constructor(config: AgentifiedClientConfig) {
    this.state = createInitialState();
    const factory = config._agentFactory ?? defaultAgentFactory;
    this.agent = factory(config.agentUrl, config.headers);
    this.agent.subscribe({
      onEvent: ({ event }) => this.handleEvent(event),
    });
  }

  getState(): InspectorState {
    return this.state;
  }

  getMessages(): Message[] {
    return this.state.messages;
  }

  registerToolHandler(name: string, handler: FrontendToolHandler): void {
    this.frontendToolHandlers.set(name, handler);
    this.state = { ...this.state, frontendTools: [...this.frontendToolHandlers.keys()] };
    this.notify();
  }

  unregisterToolHandler(name: string): void {
    this.frontendToolHandlers.delete(name);
    this.state = { ...this.state, frontendTools: [...this.frontendToolHandlers.keys()] };
    this.notify();
  }

  setSharedContext(ctx: SharedContext): void {
    this.state = { ...this.state, sharedContext: ctx };
    this.notify();
  }

  setRegisteredSkills(skills: RegisteredSkill[]): void {
    this.state = {
      ...this.state,
      skills: { ...this.state.skills, registered: skills },
    };
    this.notify();
  }

  setCostConfig(config: CostConfig): void {
    this.costConfig = config;
    this.state = { ...this.state, cost: this.computeCost() };
    this.notify();
  }

  getAvailableFrontendToolNames(): string[] {
    return [...this.frontendToolHandlers.keys()];
  }

  subscribe(listener: StateListener): Subscription {
    this.listeners.add(listener);
    return { unsubscribe: () => this.listeners.delete(listener) };
  }

  async run(input: { messages: Message[]; context?: Context[] }): Promise<void> {
    this.state = { ...this.state, isLoading: true, error: null };
    this.notify();

    try {
      await this.executeRun(input.messages, input.context, 0);
    } catch (err) {
      this.state = { ...this.state, error: (err as Error).message };
    } finally {
      this.state = { ...this.state, isLoading: false };
      this.notify();
    }
  }

  private async executeRun(messages: Message[], context?: Context[], iteration = 0): Promise<void> {
    this.agent.setMessages(messages);
    const params: Record<string, unknown> = {};
    if (context) params.context = context;
    if (this.frontendToolHandlers.size > 0) {
      params.forwardedProps = { availableFrontendTools: this.getAvailableFrontendToolNames() };
    }
    await this.agent.runAgent(Object.keys(params).length > 0 ? params : undefined);

    if (iteration >= MAX_FRONTEND_TOOL_ITERATIONS) return;

    const rerunMessages = await this.handlePendingFrontendToolCalls();
    if (rerunMessages) {
      await this.executeRun(rerunMessages, context, iteration + 1);
    }
  }

  private async handlePendingFrontendToolCalls(): Promise<Message[] | null> {
    const pending = this.state.toolCalls.filter(
      (tc) => tc.result === undefined && this.frontendToolHandlers.has(tc.name),
    );
    if (pending.length === 0) return null;

    const results = await Promise.all(
      pending.map(async (tc) => {
        const handler = this.frontendToolHandlers.get(tc.name)!;
        let result: string;
        try {
          const parsed = tc.args ? JSON.parse(tc.args) : {};
          const value = await handler(parsed);
          result = JSON.stringify(value);
        } catch (err) {
          result = JSON.stringify({ error: (err as Error).message });
        }

        this.state = {
          ...this.state,
          toolCalls: this.state.toolCalls.map((t) =>
            t.id === tc.id ? { ...t, result } : t,
          ),
        };

        return { toolCallId: tc.id, name: tc.name, args: tc.args, result, parentMessageId: tc.parentMessageId };
      }),
    );

    return reconstructMessagesWithToolResults(this.state.messages, results);
  }

  async sendMessage(content: string): Promise<void> {
    const userMessage: Message = { id: randomUUID(), role: "user", content };
    this.state = { ...this.state, messages: [...this.state.messages, userMessage] };
    this.notify();
    await this.run({ messages: this.state.messages });
  }

  reset(): void {
    this.agent.abortRun();
    this.pendingMessages.clear();
    this.currentRunToolNames = new Set();
    this.currentRunToolSignatures = new Map();
    this.cooccurrencePatterns = new Map();
    this.state = createInitialState();
    this.notify();
  }

  private handleEvent(event: BaseEvent): void {
    this.processEvent(event);
    this.state = {
      ...this.state,
      events: [
        ...this.state.events,
        { timestamp: Date.now(), event, isAgentified: isAgentifiedEvent(event) },
      ],
    };
    this.notify();
  }

  private processEvent(event: BaseEvent): void {
    switch (event.type) {
      case EventType.RUN_STARTED: {
        const e = event as unknown as { runId: string; threadId?: string };
        this.currentRunToolNames = new Set();
        this.currentRunToolSignatures = new Map();
        this.state = {
          ...this.state,
          connection: "connected",
          run: { ...this.state.run, runId: e.runId, threadId: e.threadId, startedAt: Date.now() },
        };
        break;
      }
      case EventType.RUN_FINISHED:
        this.recordRunPattern();
        this.state = {
          ...this.state,
          connection: "disconnected",
          run: {
            ...this.state.run,
            durationMs: this.state.run.startedAt ? Date.now() - this.state.run.startedAt : 0,
          },
          skills: { ...this.state.skills, suggestions: this.computeSuggestions() },
        };
        break;
      case EventType.RUN_ERROR:
        this.state = { ...this.state, connection: "error" };
        break;
      case EventType.TEXT_MESSAGE_START: {
        const e = event as unknown as { messageId: string; role?: string };
        const role = (e.role ?? "assistant") as "assistant" | "user";
        this.pendingMessages.set(e.messageId, { role, content: "" });
        const newMsg = { id: e.messageId, role, content: "" } as unknown as Message;
        this.state = {
          ...this.state,
          streaming: { ...this.state.streaming, messageCount: this.state.streaming.messageCount + 1 },
          messages: [...this.state.messages, newMsg],
        };
        break;
      }
      case EventType.TEXT_MESSAGE_CONTENT: {
        const e = event as unknown as { messageId: string; delta: string };
        const pending = this.pendingMessages.get(e.messageId);
        if (pending) {
          pending.content += e.delta;
          this.state = {
            ...this.state,
            messages: this.state.messages.map(m =>
              m.id === e.messageId 
                ? ({ ...m, content: pending.content } as unknown as Message)
                : m,
            ),
          };
        }
        if (this.state.streaming.timeToFirstTokenMs === undefined && this.state.run.startedAt) {
          this.state = {
            ...this.state,
            streaming: {
              ...this.state.streaming,
              timeToFirstTokenMs: Date.now() - this.state.run.startedAt,
            },
          };
        }
        break;
      }
      case EventType.TEXT_MESSAGE_END: {
        const e = event as unknown as { messageId: string };
        this.pendingMessages.delete(e.messageId);
        break;
      }
      case EventType.TOOL_CALL_START: {
        const e = event as unknown as { toolCallId: string; toolCallName: string; parentMessageId?: string };
        const detail: ToolCallDetail = { id: e.toolCallId, name: e.toolCallName, args: "", parentMessageId: e.parentMessageId, startedAt: Date.now() };
        this.currentRunToolNames.add(e.toolCallName);
        this.state = {
          ...this.state,
          streaming: { ...this.state.streaming, toolCallCount: this.state.streaming.toolCallCount + 1 },
          toolCalls: [...this.state.toolCalls, detail],
          skills: this.applyActivationForToolCall(this.state.skills, detail),
        };
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const e = event as unknown as { toolCallId: string; delta: string };
        this.state = {
          ...this.state,
          toolCalls: this.state.toolCalls.map(tc =>
            tc.id === e.toolCallId ? { ...tc, args: tc.args + e.delta } : tc,
          ),
        };
        break;
      }
      case EventType.TOOL_CALL_END: {
        const now = Date.now();
        const e = event as unknown as { toolCallId: string };
        const finished = this.state.toolCalls.find(tc => tc.id === e.toolCallId);
        const updatedToolCalls = this.state.toolCalls.map(tc =>
          tc.id === e.toolCallId ? { ...tc, endedAt: now, durationMs: now - tc.startedAt } : tc,
        );
        let nextSkills = this.state.skills;
        if (finished) {
          const sig = `${finished.name}::${finished.args}`;
          const seen = (this.currentRunToolSignatures.get(sig) ?? 0) + 1;
          this.currentRunToolSignatures.set(sig, seen);
          if (seen > 1) {
            nextSkills = applyReliabilityIssue(nextSkills, {
              toolName: finished.name,
              type: "retry",
              count: 1,
              lastSeen: now,
              detail: `Repeated invocation with identical arguments`,
            });
          }
        }
        this.state = {
          ...this.state,
          toolCalls: updatedToolCalls,
          skills: nextSkills,
        };
        break;
      }
      case EventType.TOOL_CALL_RESULT: {
        const e = event as unknown as { toolCallId: string; content: string };
        const updatedToolCalls = this.state.toolCalls.map(tc =>
          tc.id === e.toolCallId ? { ...tc, result: e.content } : tc,
        );
        const tc = this.state.toolCalls.find(t => t.id === e.toolCallId);
        let nextSkills = this.state.skills;
        if (tc && resultLooksLikeError(e.content)) {
          nextSkills = applyReliabilityIssue(nextSkills, {
            toolName: tc.name,
            type: "failure",
            count: 1,
            lastSeen: Date.now(),
            detail: truncate(e.content, 120),
          });
        }
        this.state = {
          ...this.state,
          toolCalls: updatedToolCalls,
          skills: nextSkills,
        };
        break;
      }
      case EventType.CUSTOM:
        if (isAgentifiedEvent(event)) {
          this.handleAgentifiedEvent(event as CustomEvent);
        }
        break;
    }
  }

  private handleAgentifiedEvent(event: CustomEvent): void {
    const { name, value } = event;

    if (name === "agentified:prefetch:complete") {
      const { tools, durationMs, tokenUsage } = value;
      this.state = {
        ...this.state,
        agentified: {
          ...this.state.agentified,
          prefetchResults: [...this.state.agentified.prefetchResults, { tools, durationMs }],
          currentTools: tools,
        },
      };
      if (tokenUsage) {
        this.state = { ...this.state, tokens: { ...this.state.tokens, ...tokenUsage } };
      }
    } else if (name === "agentified:prefetch:skipped") {
      const { tools, durationMs } = value;
      this.state = {
        ...this.state,
        agentified: {
          ...this.state.agentified,
          prefetchResults: [...this.state.agentified.prefetchResults, { tools, durationMs, skipped: true }],
        },
      };
    } else if (name === "agentified:discover:complete") {
      const { tools, durationMs, query, tokenUsage } = value;
      this.state = {
        ...this.state,
        agentified: {
          ...this.state.agentified,
          discoveries: [...this.state.agentified.discoveries, { query, tools, durationMs }],
          currentTools: tools,
        },
      };
      if (tokenUsage) {
        this.state = { ...this.state, tokens: { ...this.state.tokens, ...tokenUsage } };
      }
    } else if (name === "agentified:skills:registered") {
      const skills = (value?.skills as RegisteredSkill[]) ?? [];
      this.state = {
        ...this.state,
        skills: { ...this.state.skills, registered: skills },
      };
    } else if (name === "agentified:skill:activated") {
      const skillName = value?.skillName as string;
      const toolCallIds = (value?.toolCallIds as string[]) ?? [];
      const reasoning = value?.reasoning as string | undefined;
      if (skillName) {
        this.state = {
          ...this.state,
          skills: applySkillActivation(
            this.state.skills,
            { skillName, firstActivatedAt: Date.now(), toolCallIds, reasoning },
          ),
        };
      }
    }

    this.state = { ...this.state, cost: this.computeCost() };
  }

  private applyActivationForToolCall(
    skills: InspectorState["skills"],
    tc: ToolCallDetail,
  ): InspectorState["skills"] {
    const matching = skills.registered.filter(s => s.atoms.includes(tc.name));
    if (matching.length === 0) return skills;
    let activations = skills.activations;
    for (const skill of matching) {
      const existing = activations.find(a => a.skillName === skill.name);
      if (existing) {
        if (existing.toolCallIds.includes(tc.id)) continue;
        activations = activations.map(a =>
          a.skillName === skill.name
            ? { ...a, toolCallIds: [...a.toolCallIds, tc.id] }
            : a,
        );
      } else {
        activations = [
          ...activations,
          { skillName: skill.name, firstActivatedAt: Date.now(), toolCallIds: [tc.id] },
        ];
      }
    }
    return { ...skills, activations };
  }

  private recordRunPattern(): void {
    const tools = [...this.currentRunToolNames];
    if (tools.length < SUGGESTION_MIN_TOOLS) return;
    const covered = this.state.skills.registered.some(skill =>
      skill.atoms.length >= SUGGESTION_MIN_TOOLS &&
      skill.atoms.every(atom => this.currentRunToolNames.has(atom)) &&
      tools.every(t => skill.atoms.includes(t)),
    );
    if (covered) return;
    const key = [...tools].sort().join(",");
    this.cooccurrencePatterns.set(key, (this.cooccurrencePatterns.get(key) ?? 0) + 1);
  }

  private computeSuggestions(): SkillSuggestion[] {
    const suggestions: SkillSuggestion[] = [];
    for (const [key, count] of this.cooccurrencePatterns.entries()) {
      if (count < SUGGESTION_MIN_COOCCURRENCE) continue;
      const names = key.split(",").filter(Boolean);
      if (names.length < SUGGESTION_MIN_TOOLS) continue;
      suggestions.push({
        toolNames: names,
        cooccurrenceCount: count,
        proposedName: `skill_${names.join("_")}`,
        rationale: `Tools ${names.join(", ")} fired together in ${count} runs — propose extracting as a skill.`,
      });
    }
    suggestions.sort((a, b) => b.cooccurrenceCount - a.cooccurrenceCount);
    return suggestions;
  }

  private computeCost(): CostMetrics {
    const t = this.state.tokens;
    const c = this.costConfig;
    const inputCostUsd = (t.input * c.inputUsdPerMillion) / 1_000_000;
    const outputCostUsd = (t.output * c.outputUsdPerMillion) / 1_000_000;
    const cachedCostUsd = (t.cached * (c.cachedUsdPerMillion ?? 0)) / 1_000_000;
    return {
      totalTokens: t.input + t.output + t.cached + t.reasoning,
      inputCostUsd,
      outputCostUsd,
      cachedCostUsd,
      totalCostUsd: inputCostUsd + outputCostUsd + cachedCostUsd,
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

function defaultAgentFactory(url: string, headers?: Record<string, string>): AbstractAgent {
  return new HttpAgent({ url, headers: headers ?? {} });
}

interface ToolResult {
  toolCallId: string;
  name: string;
  args: string;
  result: string;
  parentMessageId?: string;
}

function reconstructMessagesWithToolResults(
  messages: Message[],
  results: ToolResult[],
): Message[] {
  const byParent = new Map<string, ToolResult[]>();
  for (const r of results) {
    const key = r.parentMessageId ?? "";
    const group = byParent.get(key) ?? [];
    group.push(r);
    byParent.set(key, group);
  }

  const parentIds = new Set(
    results.map((r) => r.parentMessageId).filter(Boolean),
  );

  const rebuilt = messages.map((m) => {
    if (!parentIds.has(m.id)) return m;
    const group = byParent.get(m.id)!;
    byParent.delete(m.id);
    return {
      ...m,
      toolCalls: group.map((r) => ({
        id: r.toolCallId,
        type: "function" as const,
        function: { name: r.name, arguments: r.args },
      })),
    } as unknown as Message;
  });

  // Orphan groups — no matching parent message
  for (const [, group] of byParent) {
    rebuilt.push({
      id: randomUUID(),
      role: "assistant",
      content: "",
      toolCalls: group.map((r) => ({
        id: r.toolCallId,
        type: "function" as const,
        function: { name: r.name, arguments: r.args },
      })),
    } as unknown as Message);
  }

  // Append tool result messages
  for (const r of results) {
    rebuilt.push({
      id: randomUUID(),
      role: "tool" as const,
      content: r.result,
      toolCallId: r.toolCallId,
    } as unknown as Message);
  }

  return rebuilt;
}

function createInitialState(): InspectorState {
  return {
    connection: "idle",
    run: {},
    agentified: { prefetchResults: [], discoveries: [], currentTools: [] },
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    streaming: { messageCount: 0, toolCallCount: 0 },
    toolCalls: [],
    events: [],
    messages: [],
    isLoading: false,
    error: null,
    frontendTools: [],
    skills: { registered: [], activations: [], suggestions: [], reliability: [] },
    cost: { totalTokens: 0, inputCostUsd: 0, outputCostUsd: 0, cachedCostUsd: 0, totalCostUsd: 0 },
  };
}

function applySkillActivation(
  skills: InspectorState["skills"],
  activation: SkillActivation,
): InspectorState["skills"] {
  const existing = skills.activations.find(a => a.skillName === activation.skillName);
  if (existing) {
    const toolCallIds = Array.from(new Set([...existing.toolCallIds, ...activation.toolCallIds]));
    return {
      ...skills,
      activations: skills.activations.map(a =>
        a.skillName === activation.skillName
          ? { ...a, toolCallIds, reasoning: activation.reasoning ?? a.reasoning }
          : a,
      ),
    };
  }
  return { ...skills, activations: [...skills.activations, activation] };
}

function applyReliabilityIssue(
  skills: InspectorState["skills"],
  issue: ReliabilityIssue,
): InspectorState["skills"] {
  const existing = skills.reliability.find(
    r => r.toolName === issue.toolName && r.type === issue.type,
  );
  if (existing) {
    return {
      ...skills,
      reliability: skills.reliability.map(r =>
        r.toolName === issue.toolName && r.type === issue.type
          ? { ...r, count: r.count + issue.count, lastSeen: issue.lastSeen, detail: issue.detail ?? r.detail }
          : r,
      ),
    };
  }
  return { ...skills, reliability: [...skills.reliability, issue] };
}

function resultLooksLikeError(content: string): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/^error\b/i.test(trimmed)) return true;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.error === "string" && obj.error) return true;
      if (obj.error === true) return true;
      if (typeof obj.success === "boolean" && obj.success === false) return true;
    }
  } catch {
    // not JSON — fall through
  }
  return false;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
