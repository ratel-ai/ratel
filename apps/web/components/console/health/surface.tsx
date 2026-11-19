"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * Where the page is drawn. `member` is the signed-in project page. `shared`
 * is the public read-only copy behind a share link: no link into the project
 * (catalog chips, Traces, settings), no plan upsells, and nothing that writes.
 * Client components read it here; server components take it as a prop.
 */
export type HealthSurface = "member" | "shared";

const HealthSurfaceContext = createContext<HealthSurface>("member");

export function HealthSurfaceProvider({
  surface,
  children,
}: {
  surface: HealthSurface;
  children?: ReactNode;
}) {
  return <HealthSurfaceContext.Provider value={surface}>{children}</HealthSurfaceContext.Provider>;
}

/** True on the public copy of the page. */
export function useSharedSurface(): boolean {
  return useContext(HealthSurfaceContext) === "shared";
}
