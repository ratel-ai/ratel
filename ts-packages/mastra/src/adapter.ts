import type { BaseEvent, CustomEvent } from "@ag-ui/client";
import type { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { MastraAgent } from "@ag-ui/mastra";
import { Agentified } from "@agentified/sdk";
import type {
  DiscoverToolInput,
  RankedTool,
  RegisterResponse,
  ServerTool,
} from "@agentified/sdk";
import { Observable, Subject } from "rxjs";
import { z } from "zod";
import { jsonSchemaToZod } from "./schema.js";

export interface AgentifiedMastraConfig {
  agentifiedUrl: string;
  tools: ServerTool[];
  toolHandlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  >;
  agent: Agent;
}

export interface RunOptions {
  messages: Array<{ role: string; content: string }>;
  frontendTools?: string[];
}

export class AgentifiedMastra {
  private config: AgentifiedMastraConfig;
  private sdk: Agentified;

  constructor(config: AgentifiedMastraConfig) {
    this.config = config;
    this.sdk = new Agentified({
      serverUrl: config.agentifiedUrl,
      tools: config.tools,
    });
  }

  async register(): Promise<RegisterResponse> {
    return this.sdk.register();
  }

  async run(options: RunOptions): Promise<Observable<BaseEvent>> {
    const allFrontendNames = this.sdk.getFrontendToolNames();
    const available = new Set(options.frontendTools ?? []);
    const unavailable = allFrontendNames.filter((n) => !available.has(n));

    const prefetchStart = performance.now();
    const ranked = await this.sdk.prefetch({
      messages: options.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      exclude: unavailable.length > 0 ? unavailable : undefined,
    });
    const prefetchDurationMs = performance.now() - prefetchStart;

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
      const mastraAgent = new MastraAgent({ agent: this.config.agent, resourceId: this.config.agent.name });
      subscriber.next({
        type: "RUN_STARTED",
        runId,
        threadId,
      } as BaseEvent);

      subscriber.next({
        type: "CUSTOM",
        name: "agentified:prefetch:complete",
        value: { tools: ranked, durationMs: prefetchDurationMs },
      } as CustomEvent);

      const agentObs = mastraAgent.run({
        messages: options.messages.map((m) => ({
          id: crypto.randomUUID(),
          role: m.role as "user" | "assistant" | "system",
          content: m.content,
        })),
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
  private buildMastraTools(ranked: RankedTool[]): Record<string, any> {
    const names = new Set(ranked.map((t) => t.name));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Record<string, any> = {};

    for (const def of this.config.tools) {
      if (!names.has(def.name)) continue;
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
            tools,
            durationMs: performance.now() - start,
          },
        } as CustomEvent);

        return tools;
      },
    });
  }
}
