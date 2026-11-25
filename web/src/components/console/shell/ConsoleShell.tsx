import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AppFrame } from "@/components/console/shell/AppFrame";
import { composition } from "@/lib/composition";
import { focusedConsoleOrganizationIds } from "@/lib/console/focused-console";
import { getConsoleScope } from "@/lib/console/shell-data";
import {
  parseSidebarCollapsedCookie,
  SIDEBAR_COLLAPSED_COOKIE,
} from "@/lib/console/sidebar-cookie";
import type { EditionUi } from "@/lib/contracts/composition";
import { productName } from "@/lib/platform/product-name";
import { hallucinationOrganizationIds } from "@/lib/readings/trace-signals/hallucinations/gate";
import { sentimentOrganizationIds } from "@/lib/readings/trace-signals/outcomes/gate";
import { entityPagesOrganizationIds } from "@/lib/views/project-entities/nav";

/** The console's rail and page, with its data resolved on the server. */
export async function ConsoleShell({ ui, children }: { ui?: EditionUi; children: ReactNode }) {
  const [scope, cookieStore, accountNote] = await Promise.all([
    getConsoleScope(),
    cookies(),
    ui?.accountNote?.(),
  ]);
  const AccountMenuItems = ui?.AccountMenuItems;
  const AccountMenuEndItems = ui?.AccountMenuEndItems;
  const ConsoleBoundary = ui?.ConsoleBoundary;
  const ConsoleOverlays = ui?.ConsoleOverlays;
  const ScopeSwitcher = scope ? ui?.ScopeSwitcher : undefined;
  // Every organization the reader belongs to and their projects: the frame picks the one shown.
  const projects = scope?.memberProjects ?? [];
  const organizations = scope?.organizations ?? [];
  // Decided per organization: a flag read that fails keeps the item out of the rail.
  const [
    entityPagesOrganizations,
    focusedConsoleOrganizations,
    sentimentOrganizations,
    hallucinationOrganizations,
  ] = await Promise.all([
    entityPagesOrganizationIds(organizations),
    focusedConsoleOrganizationIds(organizations),
    sentimentOrganizationIds(organizations).catch(() => []),
    hallucinationOrganizationIds(organizations).catch(() => []),
  ]);
  const hiddenOrganizationNav = ui?.hiddenOrganizationNav;
  const hidden: Record<string, readonly string[]> = hiddenOrganizationNav
    ? Object.fromEntries(
        await Promise.all(
          organizations.map(async ({ slug }) => [slug, await hiddenOrganizationNav(slug)] as const),
        ),
      )
    : {};
  return (
    <>
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
          organizations,
          projects,
          account: scope?.account ? { ...scope.account, note: accountNote ?? null } : null,
          editionNav: composition.nav,
          organizationNav: composition.organizationNav,
          hiddenOrganizationNav: hidden,
          projectNav: composition.projectNav,
          entityPagesOrganizations,
          sentimentOrganizations,
          hallucinationOrganizations,
          focusedConsoleOrganizations,
          productName: productName(),
          scopeSwitcher: ScopeSwitcher
            ? {
                expanded: <ScopeSwitcher projects={projects} collapsed={false} />,
                collapsed: <ScopeSwitcher projects={projects} collapsed />,
              }
            : null,
          accountMenuItems: AccountMenuItems ? <AccountMenuItems /> : null,
          accountMenuEndItems: AccountMenuEndItems ? <AccountMenuEndItems /> : null,
          overlays: ConsoleOverlays ? <ConsoleOverlays /> : null,
          commandActions: ui?.commandActions ?? [],
          initiallyCollapsed: parseSidebarCollapsedCookie(
            cookieStore.get(SIDEBAR_COLLAPSED_COOKIE)?.value,
          ),
        }}
      >
        {ConsoleBoundary ? <ConsoleBoundary>{children}</ConsoleBoundary> : children}
      </AppFrame>
    </>
  );
}
