import type { ReactNode } from "react";
import { ConsoleShell } from "@/components/console/shell/ConsoleShell";
import { composition } from "@/lib/composition";

/**
 * Shell for every console page (DESIGN.md, Layout). An edition's access gate decides first, so
 * the shell resolves its data only for someone it lets in.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const ui = await composition.ui?.();
  const ConsoleBanner = ui?.ConsoleBanner;
  const ConsoleAccessGate = ui?.ConsoleAccessGate;
  const shell = <ConsoleShell ui={ui}>{children}</ConsoleShell>;
  return (
    <div className="min-h-dvh bg-app">
      {ConsoleBanner ? <ConsoleBanner /> : null}
      {ConsoleAccessGate ? <ConsoleAccessGate>{shell}</ConsoleAccessGate> : shell}
    </div>
  );
}
