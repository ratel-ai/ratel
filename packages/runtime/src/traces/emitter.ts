import type { Trace, TraceEmitter, TraceHandler } from "../types"

export type { Trace, TraceEmitter, TraceHandler }

export function createTraceEmitter(): TraceEmitter {
  const handlers: TraceHandler[] = []

  return {
    async emit(trace: Trace): Promise<void> {
      for (const handler of handlers) {
        try {
          await handler(trace)
        } catch {
          // Continue with other handlers even if one fails
        }
      }
    },

    addHandler(handler: TraceHandler): void {
      handlers.push(handler)
    },
  }
}
