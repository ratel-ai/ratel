import type { ReactNode } from "react";

/**
 * One irreversible action on a Danger zone tab, under its Section title: what
 * it does, and the button that opens its typed confirmation. A danger
 * hairline marks the row; the red fill is kept for the button inside the
 * dialog.
 */
export function DangerRow({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <div className="flex max-w-3xl flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-danger/30 px-4 py-3">
      <div className="min-w-0 flex-1 basis-64 text-ui text-fg-muted">{children}</div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
