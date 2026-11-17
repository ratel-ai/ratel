"use client";

import { createContext, type ReactNode, useContext } from "react";

/** Whether the Traces area runs as Sessions (`cloud-traces-sessions`): the first tab reads "Sessions", not "Runs". */
const TracesSessionsContext = createContext(false);

export function TracesSessionsProvider({ children }: { children: ReactNode }) {
  return <TracesSessionsContext.Provider value={true}>{children}</TracesSessionsContext.Provider>;
}

export function useTracesSessions(): boolean {
  return useContext(TracesSessionsContext);
}
