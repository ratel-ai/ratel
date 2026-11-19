"use client";

import { createContext, useContext } from "react";
import { loadStepContentAction, type StepContentResult } from "@/lib/views/session-chat/actions";
import type { StepContentRequest } from "@/lib/views/session-chat/inspect-load";

/**
 * Where the step inspector reads a step's stored text from. The console reads
 * it through its server action; an MCP view (mcp-apps/views/replay) provides
 * its own loader, a tools/call to get_session_step_content, with
 * <StepContentLoaderContext.Provider>.
 */
export type StepContentLoader = (
  projectId: string,
  request: StepContentRequest,
) => Promise<StepContentResult>;

export const StepContentLoaderContext = createContext<StepContentLoader>(loadStepContentAction);

export function useStepContentLoader(): StepContentLoader {
  return useContext(StepContentLoaderContext);
}
