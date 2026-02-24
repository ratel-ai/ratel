import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentifiedClient, InspectorState } from "@agentified/fe-client";

export type RunFn = (input: { threadId?: string; runId?: string }) => void;

export interface AgentifiedContextValue {
  state: InspectorState;
  client: AgentifiedClient;
  run: RunFn;
  reset: () => void;
}

export const AgentifiedContext = createContext<AgentifiedContextValue | null>(null);

export interface AgentifiedProviderProps {
  client: AgentifiedClient;
  onRun?: RunFn;
  children: ReactNode;
}

export function AgentifiedProvider({ client, onRun, children }: AgentifiedProviderProps) {
  const [state, setState] = useState<InspectorState>(() => client.getState());
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  useEffect(() => {
    setState(client.getState());
    const sub = client.subscribe((next) => setState(next));
    return () => sub.unsubscribe();
  }, [client]);

  const run = useCallback<RunFn>((input) => {
    onRunRef.current?.(input);
  }, []);

  const reset = useCallback(() => {
    client.reset();
  }, [client]);

  const value = useMemo<AgentifiedContextValue>(
    () => ({ state, client, run, reset }),
    [state, client, run, reset],
  );

  return <AgentifiedContext.Provider value={value}>{children}</AgentifiedContext.Provider>;
}
