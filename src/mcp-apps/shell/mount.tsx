"use client";

import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { McpAppBinding } from "@/lib/mcp/apps/types";
import { RatelViewProvider } from "./bridge";
import { installMemoryHistory } from "./shims/next-navigation";

/** A view's entry point: `mountView({ name, bindings }, <MyView />)` in views/<view>/main.tsx. */
export function mountView(
  { name, bindings }: { name: string; bindings: readonly McpAppBinding[] },
  view: ReactNode,
): void {
  installMemoryHistory();
  const root = document.getElementById("root");
  if (!root) throw new Error("#root is missing from the view document");
  createRoot(root).render(
    <StrictMode>
      <RatelViewProvider name={name} bindings={bindings}>
        {view}
      </RatelViewProvider>
    </StrictMode>,
  );
}
