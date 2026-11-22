"use client";

import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import type { WorkflowRowView } from "@/lib/readings/trace-signals/view";

/**
 * Which workflow the flow map is focused on, shared by the Workflows list
 * (which picks one) and the flow map (which hides everything but that
 * workflow's runs, through the same filter as "Needs first"). A pick is a
 * passing look, not a setting, so it is never stored: every page load starts
 * on the viewer's own map.
 */
export interface WorkflowFocusState {
  projectId: string;
  focus: WorkflowRowView | null;
  setFocus: (workflow: WorkflowRowView | null) => void;
}

const WorkflowFocusContext = createContext<WorkflowFocusState | null>(null);

export function WorkflowFocusProvider({
  projectId,
  children,
}: {
  projectId: string;
  children?: ReactNode;
}) {
  const [focus, setFocus] = useState<WorkflowRowView | null>(null);
  const value = useMemo(() => ({ projectId, focus, setFocus }), [projectId, focus]);
  return <WorkflowFocusContext.Provider value={value}>{children}</WorkflowFocusContext.Provider>;
}

/** The shared focus; null outside a provider (the map then draws as it always has). */
export function useWorkflowFocus(): WorkflowFocusState | null {
  return useContext(WorkflowFocusContext);
}
