import type { ContextStrategy, RankedTool, RecallConfig } from "./types.js";

export interface ContextAssembledEvent {
  sessionId: string;
  datasetId: string;
  strategyUsed: ContextStrategy;
  totalMessages: number;
  includedMessages: number;
  tokenEstimate: number;
  fallback: boolean;
  recalled: { tools: RankedTool[] };
  durationMs: number;
}

export interface RecallEvent {
  sessionId: string;
  datasetId: string;
  config: RecallConfig | undefined;
  matches: RankedTool[];
  durationMs: number;
}

export interface StepEvent {
  sessionId?: string;
  stepIndex: number;
  toolCalls: unknown[];
  toolResults: unknown[];
  usage?: unknown;
  finishReason?: string;
  durationMs?: number;
}

export interface ObserverEventMap {
  "context:assembled": ContextAssembledEvent;
  recall: RecallEvent;
  step: StepEvent;
}

export type ObserverEventName = keyof ObserverEventMap;

export type ObserverListener<K extends ObserverEventName> = (
  evt: ObserverEventMap[K],
) => void | Promise<void>;

export type Unsubscribe = () => void;

export class ObserverEmitter {
  private listeners: Map<string, Set<(evt: unknown) => void | Promise<void>>> = new Map();

  on<K extends ObserverEventName>(name: K, cb: ObserverListener<K>): Unsubscribe {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    const set = this.listeners.get(name)!;
    set.add(cb as (evt: unknown) => void | Promise<void>);
    return () => {
      set.delete(cb as (evt: unknown) => void | Promise<void>);
    };
  }

  emit<K extends ObserverEventName>(name: K, evt: ObserverEventMap[K]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const cb of set) {
      try {
        const r = cb(evt);
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch(() => { /* swallow async errors */ });
        }
      } catch {
        /* swallow listener errors */
      }
    }
  }
}
