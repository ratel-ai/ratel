"use client";

import { createContext, useContext } from "react";

const FocusedConsoleContext = createContext(false);

/** Whether the organization in view has `focusedConsole`, for what cannot ask on the server (a loading state). */
export const FocusedConsoleProvider = FocusedConsoleContext.Provider;

export function useFocusedConsole(): boolean {
  return useContext(FocusedConsoleContext);
}
