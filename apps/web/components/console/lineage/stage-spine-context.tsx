"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * Whether `cloud-stage-spine` (RC-45) is on for this session, resolved once by
 * the shell on the server and handed to client components (an issue's or a
 * fix's panel) that show lineage links, so none of them threads a prop.
 */
const StageSpineContext = createContext(false);

export function StageSpineProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children?: ReactNode;
}) {
  return <StageSpineContext.Provider value={enabled}>{children}</StageSpineContext.Provider>;
}

export function useStageSpine(): boolean {
  return useContext(StageSpineContext);
}
