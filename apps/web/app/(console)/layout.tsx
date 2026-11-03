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
  const [scope, cookieStore, ui] = await Promise.all([
    getConsoleScope(),
    cookies(),
    composition.ui?.(),
  ]);
  const AccountMenuItems = ui?.AccountMenuItems;
  const ScopeSwitcher = scope ? ui?.ScopeSwitcher : undefined;
  const projects = scope?.projects ?? [];
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
          organizationSlug: scope?.organizationSlug ?? null,
          projects,
          account: scope?.account ?? null,
          editionNav: composition.nav,
          organizationNav: composition.organizationNav,
          scopeSwitcher: ScopeSwitcher
            ? {
                expanded: <ScopeSwitcher projects={projects} collapsed={false} />,
                collapsed: <ScopeSwitcher projects={projects} collapsed />,
              }
            : null,
          accountMenuItems: AccountMenuItems ? <AccountMenuItems /> : null,
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
