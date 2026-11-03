"use client";

import { Panel, usePeek } from "@ratel/design-system/panel";
import type { ReactNode } from "react";

/** The panel id Overview opens from the Spend stat and from context items. */
export const CONTEXT_PEEK = "context";

/**
 * Where the context goes, over the Overview (DESIGN.md, Overlays): opened by
 * `?peek=context`, so the Spend stat and a "Needs attention" item can link to
 * it. The body is rendered on the server and passed in.
 */
export function ContextPanel({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  const peek = usePeek();
  return (
    <Panel
      open={peek.id === CONTEXT_PEEK}
      onOpenChange={(open) => {
        if (!open) peek.close();
      }}
      title="Where your context goes"
      subtitle={subtitle}
    >
      {children}
    </Panel>
  );
}
