"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * The `rql` flag for the widget editors of a surface (Explore, a dashboard): with it on, a widget
 * can be of kind sql and a metric has `Edit as SQL`. The page reads the flag and gives it here.
 * Off by default, so a surface without the provider shows no SQL control.
 */
const RqlFlagContext = createContext(false);

export function RqlFlagProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <RqlFlagContext value={enabled}>{children}</RqlFlagContext>;
}

export function useRqlFlag(): boolean {
  return useContext(RqlFlagContext);
}
