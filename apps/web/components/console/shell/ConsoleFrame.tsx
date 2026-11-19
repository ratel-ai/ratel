import type { ReactNode } from "react";
import { ConsoleShell } from "@/components/console/shell/ConsoleShell";
import { composition } from "@/lib/composition";

/**
 * The console around a page (DESIGN.md, Layout): the edition's banner, then its access gate, then
 * the shell. The gate decides first, so the shell resolves its data only for someone it lets in.
 */
export async function ConsoleFrame({ children }: { children: ReactNode }) {
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
