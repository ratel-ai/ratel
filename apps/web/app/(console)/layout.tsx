import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AppFrame } from "@/components/console/shell/AppFrame";
import { composition } from "@/lib/composition";
import { getConsoleScope } from "@/lib/console/shell-data";
import {
  parseSidebarCollapsedCookie,
  SIDEBAR_COLLAPSED_COOKIE,
} from "@/lib/console/sidebar-cookie";

/** Shell for every console page (DESIGN.md, Layout), with its data resolved on the server. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const [scope, cookieStore] = await Promise.all([getConsoleScope(), cookies()]);
  return (
    <div className="min-h-dvh bg-app">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:rounded-md focus:border focus:border-line focus:bg-overlay focus:px-3 focus:py-2 focus:text-sm focus:text-fg focus:outline-none focus:ring-2 focus:ring-focus"
      >
        Skip to content
      </a>
      <AppFrame
        data={{
          organizationName: scope?.organizationName ?? null,
          projects: scope?.projects ?? [],
          editionNav: composition.nav,
          initiallyCollapsed: parseSidebarCollapsedCookie(
            cookieStore.get(SIDEBAR_COLLAPSED_COOKIE)?.value,
          ),
        }}
      >
        {children}
      </AppFrame>
    </div>
  );
}
