import type { BaseEvent, CustomEvent, Message } from "@ag-ui/client";
import { createTool } from "@mastra/core/tools";
import { MastraAgent } from "@ag-ui/mastra";
import { ApiClient } from "@agentified/sdk";
import type {
  DiscoverToolInput,
  RankedTool,
  RegisterResponse,
  ServerTool,
} from "@agentified/sdk";
import { Observable, Subject } from "rxjs";
import { z } from "zod";
import { jsonSchemaToZod } from "./schema.js";

export interface GenerateOptions {
  messages: Array<{ role: string; content: string }>;
  maxSteps?: number;
  turnId?: string;
  toolLimit?: number;
  seed?: number;
  debug?: boolean;
  onStepFinish?: (event: { usage: any; toolCalls: any[] }) => void;
}

export interface DebugEntry {
  phase: string;
  detail: Record<string, unknown>;
}

export interface GenerateResult {
  text: string;
  toolCalls: Array<{ toolName: string; toolCallId: string; args: Record<string, unknown> }>;
  steps: any[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  };
  hydratedTools: string[];
  turnId?: string;
  durationMs: number;
  debugLog?: DebugEntry[];
}

export interface AgentifiedMastraConfig {
  agentifiedUrl: string;
  tools: ServerTool[];
  toolHandlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  >;
  // Loose type avoids #private brand mismatch when consumer resolves
  // a different copy of @mastra/core (common in pnpm workspaces).
  agent: { name: string; generate: (...args: any[]) => any; stream: (...args: any[]) => any };
}

export interface RunOptions {
  messages: Array<{
    role: string;
    content: string;
    toolCallId?: string;
    toolCalls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }>;
  frontendTools?: string[];
}

/** @deprecated Use the new `Agentified` class instead. This class will be removed in a future version. */
export class AgentifiedMastra {
  private config: AgentifiedMastraConfig;
  private sdk: ApiClient;
  private lastPrefetchResult: { ranked: RankedTool[]; durationMs: number } | null = null;

  constructor(config: AgentifiedMastraConfig) {
    this.config = config;
    this.sdk = new ApiClient({
      serverUrl: config.agentifiedUrl,
      tools: config.tools,
    });
    this.patchAgentStreamForGemini();
  }

  /**
   * WORKAROUND: @ag-ui/mastra strips providerOptions during message conversion,
   * losing Gemini 3's required thoughtSignature on function call parts.
   * We wrap agent.stream() to inject a dummy signature so Gemini 3 doesn't 400.
   *
   * Tracked: https://github.com/ag-ui-protocol/ag-ui/issues/TBD
   * Remove when: ag-ui preserves providerOptions in convertAGUIMessagesToMastra()
   */
  private patchAgentStreamForGemini(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent = this.config.agent as any;
    const originalStream = agent.stream.bind(agent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent.stream = async (messages: any[], ...rest: any[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const patched = messages.map((m: any) => {
        if (
          m.role === "assistant" &&
          Array.isArray(m.content) &&
          m.content.some((p: any) => p.type === "tool-call")
        ) {
          return {
            ...m,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            content: m.content.map((part: any) => {
              if (part.providerOptions?.google?.thoughtSignature) return part;
              return {
                ...part,
                providerOptions: {
                  ...part.providerOptions,
                  google: {
                    ...part.providerOptions?.google,
                    thoughtSignature: "skip_thought_signature_validator",
                  },
                },
              };
            }),
          };
        }
        return m;
      });
      return originalStream(patched, ...rest);
    };
  }

  private static hasToolResults(messages: RunOptions["messages"]): boolean {
    return messages.some((m) => m.role === "tool");
  }

  async register(): Promise<RegisterResponse> {
    return this.sdk.register();
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const start = performance.now();
    const debug = options.debug ?? false;
    const debugLog: DebugEntry[] = [];

    const log = (phase: string, detail: Record<string, unknown>) => {
      if (!debug) return;
      debugLog.push({ phase, detail });
      console.error(`[agentified] ${phase}:`, JSON.stringify(detail));
    };

    // 1. Prefetch (with turnId for session continuity)
    const ranked = await this.sdk.prefetch({
      messages: options.messages.map(m => ({ role: m.role, content: m.content })),
      turnId: options.turnId,
      ...(options.toolLimit !== undefined && { limit: options.toolLimit }),
    }) ?? [];
    const prefilledNames = ranked.map(t => t.name);

    log("prefetch", {
      toolCount: ranked.length,
      tools: ranked.map(t => ({ name: t.name, score: t.score })),
    });

    // 2. Build ALL tools (not just ranked — needed for discover → use)
    const allTools = this.buildAllMastraTools();
    const registryNames = new Set(Object.keys(allTools));

    // 3. Discover tool
    const discoverDef = this.sdk.asDiscoverTool();
    const discoverTool = createTool({
      id: "agentified_discover",
      description: discoverDef.definition.description,
      inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
      execute: async (input) => {
        const result = await discoverDef.execute(input as DiscoverToolInput);
        log("discover-result", {
          query: input.query,
          tools: Array.isArray(result) ? result.map((t: any) => t.name) : result,
        });
        return result;
      },
    });

    // 4. Active tool set — grows as discover returns results
    const activeSet = new Set<string>(prefilledNames);
    activeSet.add("agentified_discover");

    // 5. Inject full tool set into agent
    const fullTools = { ...allTools, agentified_discover: discoverTool };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.config.agent as any).__setTools(fullTools);

    log("setup", {
      totalToolsRegistered: Object.keys(fullTools).length,
      initialActiveSet: [...activeSet],
    });

    // 6. Call agent.generate() with prepareStep
    const result = await this.config.agent.generate(options.messages as any, {
      maxSteps: options.maxSteps ?? 10,
      ...(options.seed !== undefined && { seed: options.seed }),
      onStepFinish: options.onStepFinish,
      prepareStep: async ({ stepNumber, steps }: { stepNumber: number; steps: any[] }) => {
        // Merge discovered tools from prior steps (handle AG-UI payload wrapping)
        const prevSize = activeSet.size;
        for (const step of steps) {
          for (const tr of step.toolResults ?? []) {
            const trName = tr.toolName ?? tr.payload?.toolName;
            const trResult = tr.result ?? tr.payload?.result;
            if (trName === "agentified_discover" && Array.isArray(trResult)) {
              for (const t of trResult) {
                if (registryNames.has(t.name)) activeSet.add(t.name);
              }
            }
          }
        }

        const newTools = activeSet.size > prevSize
          ? [...activeSet].filter(n => !prefilledNames.includes(n) && n !== "agentified_discover")
          : [];

        log("prepareStep", {
          stepNumber,
          activeSet: [...activeSet],
          newlyAdded: newTools.length > 0 ? newTools : undefined,
        });

        return { activeTools: [...activeSet] };
      },
    });

    // 7. Collect tool calls (excluding discover)
    // Mastra wraps tool calls in AG-UI events: { payload: { toolName, toolCallId, args } }
    const toolCalls: GenerateResult["toolCalls"] = [];
    for (const step of result.steps ?? []) {
      for (const _tc of step.toolCalls ?? []) {
        const tc = _tc as any;
        const name = tc.toolName ?? tc.payload?.toolName;
        const id = tc.toolCallId ?? tc.payload?.toolCallId;
        const args = tc.args ?? tc.payload?.args ?? {};
        if (name === "agentified_discover") continue;
        toolCalls.push({ toolName: name, toolCallId: id, args });
      }
    }

    // 8. Post-process: expand activeSet from result steps
    for (const step of result.steps ?? []) {
      for (const _tr of step.toolResults ?? []) {
        const tr = _tr as any;
        const trName = tr.toolName ?? tr.payload?.toolName;
        const trResult = tr.result ?? tr.payload?.result;
        if (trName === "agentified_discover" && Array.isArray(trResult)) {
          for (const t of trResult) {
            if (registryNames.has(t.name)) activeSet.add(t.name);
          }
        }
      }
    }

    // 9. Capture turn for session continuity
    const toolsLoaded = [...activeSet].filter(n => n !== "agentified_discover");
    let turnId: string | undefined;
    try {
      const capture = await this.sdk.captureTurn({
        toolsLoaded,
        message: options.messages[options.messages.length - 1]?.content ?? "",
      });
      turnId = capture.turnId;
    } catch { /* non-fatal */ }

    const usage = (result.usage ?? {}) as any;
    const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
    const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
    return {
      text: result.text ?? "",
      toolCalls,
      steps: result.steps ?? [],
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: usage.totalTokens ?? (inputTokens + outputTokens),
        cachedInputTokens: usage.cachedInputTokens,
        reasoningTokens: usage.reasoningTokens,
      },
      hydratedTools: toolsLoaded,
      turnId,
      durationMs: performance.now() - start,
      ...(debug && { debugLog }),
    };
  }

  async run(options: RunOptions): Promise<Observable<BaseEvent>> {
    const allFrontendNames = this.sdk.getFrontendToolNames();
    const available = new Set(options.frontendTools ?? []);
    const unavailable = allFrontendNames.filter((n) => !available.has(n));

    let ranked: RankedTool[];
    let prefetchDurationMs: number;
    let prefetchSkipped = false;

    if (this.lastPrefetchResult && AgentifiedMastra.hasToolResults(options.messages)) {
      ranked = this.lastPrefetchResult.ranked;
      prefetchDurationMs = this.lastPrefetchResult.durationMs;
      prefetchSkipped = true;
    } else {
      const prefetchStart = performance.now();
      ranked = await this.sdk.prefetch({
        messages: options.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        exclude: unavailable.length > 0 ? unavailable : undefined,
      });
      prefetchDurationMs = performance.now() - prefetchStart;
      this.lastPrefetchResult = { ranked, durationMs: prefetchDurationMs };
    }

    const subject = new Subject<BaseEvent>();
    const mastraTools = this.buildMastraTools(ranked);
    const discoverTool = this.createDiscoverMastraTool(subject);

    const frontendToolDefs = this.sdk
      .getFrontendTools()
      .filter((t) => available.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));

    const runId = crypto.randomUUID();
    const threadId = crypto.randomUUID();

    return new Observable<BaseEvent>((subscriber) => {
      // Inject tools synchronously (safe: runs on subscribe, same tick)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.config.agent as any).__setTools({ ...mastraTools, agentified_discover: discoverTool });
      const mastraAgent = new MastraAgent({ agent: this.config.agent as any, resourceId: this.config.agent.name });
      subscriber.next({
        type: "RUN_STARTED",
        runId,
        threadId,
      } as BaseEvent);

      subscriber.next({
        type: "CUSTOM",
        name: prefetchSkipped ? "agentified:prefetch:skipped" : "agentified:prefetch:complete",
        value: { tools: ranked, durationMs: prefetchDurationMs },
      } as CustomEvent);

      const agentObs = mastraAgent.run({
        messages: options.messages.map((m) => {
          const msg: Record<string, unknown> = {
            id: crypto.randomUUID(),
            role: m.role as "user" | "assistant" | "system" | "tool",
            content: m.content,
          };
          if (m.toolCallId) msg.toolCallId = m.toolCallId;
          if (m.toolCalls) msg.toolCalls = m.toolCalls;
          return msg;
        }) as Message[],
        threadId,
        runId,
        tools: frontendToolDefs,
        context: [],
      });

      const agentSub = agentObs.subscribe({
        next: (e) => {
          if (e.type === "RUN_STARTED") return;
          subscriber.next(e);
        },
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });

      const subjectSub = subject.subscribe({
        next: (e) => subscriber.next(e),
      });

      return () => {
        agentSub.unsubscribe();
        subjectSub.unsubscribe();
      };
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildAllMastraTools(): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Record<string, any> = {};
    for (const def of this.config.tools) {
      const handler = this.config.toolHandlers[def.name];
      if (!handler) continue;
      tools[def.name] = createTool({
        id: def.name,
        description: def.description,
        inputSchema: jsonSchemaToZod(def.parameters),
        execute: async (inputData) =>
          handler(inputData as Record<string, unknown>),
      });
    }
    return tools;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildMastraTools(ranked: RankedTool[]): Record<string, any> {
    const names = new Set(ranked.map((t) => t.name));
    const all = this.buildAllMastraTools();
    return Object.fromEntries(Object.entries(all).filter(([n]) => names.has(n)));
  }

  private createDiscoverMastraTool(subject: Subject<BaseEvent>) {
    const discoverTool = this.sdk.asDiscoverTool();

    return createTool({
      id: discoverTool.definition.name,
      description: discoverTool.definition.description,
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().optional(),
      }),
      execute: async (input) => {
        subject.next({
          type: "CUSTOM",
          name: "agentified:discover:start",
          value: { type: "agentified:discover:start", query: input.query },
        } as CustomEvent);

        const start = performance.now();
        const tools = await discoverTool.execute(
          input as unknown as DiscoverToolInput,
        );

        subject.next({
          type: "CUSTOM",
          name: "agentified:discover:complete",
          value: {
            type: "agentified:discover:complete",
            query: input.query,
            tools,
            durationMs: performance.now() - start,
          },
        } as CustomEvent);

        return tools;
      },
    });
  }
}
