import { type ReactNode, Suspense } from "react";
import { ConsoleShell } from "@/components/console/shell/ConsoleShell";
import { ShellSkeleton } from "@/components/console/shell/ShellSkeleton";
import { composition } from "@/lib/composition";

/**
 * Shell for every console page (DESIGN.md, Layout). The layout renders synchronously and wraps the
 * async shell in <Suspense>, as upstream's, so a hard load or an entry into the console draws the
 * shell skeleton at once instead of a blank page while the session and the navigation resolve.
 * Navigations inside the console keep this layout mounted, so the skeleton shows only on entry.
 */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <ConsoleFrame>{children}</ConsoleFrame>
    </Suspense>
  );
}

/** An edition's access gate decides first, so the shell resolves its data only for someone it lets in. */
async function ConsoleFrame({ children }: { children: ReactNode }) {
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
