import { type ReactNode, Suspense } from "react";
import { ConsoleFrame } from "@/components/console/shell/ConsoleFrame";
import { ShellSkeleton } from "@/components/console/shell/ShellSkeleton";

/**
 * Shell for every console page. The layout renders synchronously and wraps the async frame in
 * <Suspense>, as upstream's, so a hard load or an entry into the console draws the shell skeleton
 * at once instead of a blank page while the session and the navigation resolve. Navigations
 * inside the console keep this layout mounted, so the skeleton shows only on entry.
 */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <ConsoleFrame>{children}</ConsoleFrame>
    </Suspense>
  );
}
