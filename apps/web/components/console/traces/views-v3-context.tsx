"use client";

import { createContext, type ReactNode, useContext } from "react";
import { type RunNoun, runNoun } from "@/lib/synthesis/traces/v2/run-noun";

/** Whether the redesigned trace and session views are on (`cloud-trace-views-v3`, RC-394). Off by default. */
const TraceViewsV3Context = createContext(false);

export function TraceViewsV3Provider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return <TraceViewsV3Context.Provider value={enabled}>{children}</TraceViewsV3Context.Provider>;
}

export function useTraceViewsV3(): boolean {
  return useContext(TraceViewsV3Context);
}

/** "Turn" with the redesign on, "Run" without (RC-413). */
export function useRunNoun(): RunNoun {
  return runNoun(useContext(TraceViewsV3Context));
}
