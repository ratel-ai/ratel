"use client";

import { Dialog } from "@base-ui/react/dialog";
import { IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { isTypingTarget } from "@ratel/design-system/peek";
import { Toaster } from "@ratel/design-system/toast";
import { TooltipProvider } from "@ratel/design-system/tooltip";
import { Menu, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeNavItemId,
  commandEntries,
  consoleNav,
  findProject,
  projectIdFromPath,
  shortcutHref,
} from "@/lib/console/navigation";
import { serializeSidebarCollapsedCookie } from "@/lib/console/sidebar-cookie";
import { CommandMenu } from "./CommandMenu";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { SidebarContent } from "./Sidebar";
import type { ShellData } from "./types";

/**
 * The console shell (DESIGN.md, Layout): rail on the left, the page on the right, no top bar.
 * Owns the global keyboard (⌘K, `[`, `?`, `g` then a letter), the mobile drawer and the
 * app-wide overlays.
 */
/** How long `g` waits for its second key. */
const JUMP_WINDOW_MS = 1200;

export function AppFrame({ data, children }: { data: ShellData; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const jumpArmedAt = useRef(0);
  const [collapsed, setCollapsed] = useState(data.initiallyCollapsed);
  // The drawer remembers the page it was opened on, so any navigation closes it without an effect.
  const [mobileOpenOn, setMobileOpenOn] = useState<string | null>(null);
  const mobileOpen = mobileOpenOn === pathname;
  const setMobileOpen = useCallback(
    (open: boolean) => setMobileOpenOn(open ? pathname : null),
    [pathname],
  );
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const project = findProject(data.projects, projectIdFromPath(pathname));
  const items = useMemo(
    () =>
      consoleNav({
        projectId: project?.id,
        organizationSlug: data.organizationSlug ?? undefined,
        additions: data.editionNav,
      }),
    [project, data.organizationSlug, data.editionNav],
  );
  const activeId = activeNavItemId(pathname, items);
  const entries = useMemo(
    () =>
      commandEntries({
        items,
        projects: data.projects,
        pathname,
        organizationSlug: data.organizationSlug ?? undefined,
      }),
    [items, data.projects, pathname, data.organizationSlug],
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is not in every supported browser
      document.cookie = serializeSidebarCollapsedCookie(next);
      return next;
    });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((current) => !current);
        return;
      }
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTypingTarget(event.target)
      )
        return;
      // An open dialog or panel owns the keyboard.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (event.key === "[") {
        event.preventDefault();
        toggleCollapsed();
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (event.key === "g") {
        jumpArmedAt.current = Date.now();
        return;
      }
      if (jumpArmedAt.current && Date.now() - jumpArmedAt.current < JUMP_WINDOW_MS) {
        jumpArmedAt.current = 0;
        const href = shortcutHref(items, event.key);
        if (href) {
          event.preventDefault();
          router.push(href);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, router, toggleCollapsed]);

  const sidebarProps = {
    items,
    activeId,
    organizationName: data.organizationName,
    organizationSlug: data.organizationSlug,
    projects: data.projects,
    project,
    account: data.account,
    onSearch: () => setCommandOpen(true),
    onShortcuts: () => setShortcutsOpen(true),
  };

  return (
    <TooltipProvider>
      <div className="flex min-h-dvh bg-app text-fg">
        <aside
          aria-label="Sidebar"
          data-collapsed={collapsed || undefined}
          className={cn(
            "sticky top-0 z-rail hidden h-dvh shrink-0 border-r border-line bg-rail transition-[width] duration-200 ease-enter motion-reduce:transition-none md:block",
            collapsed ? "w-12" : "w-60",
          )}
        >
          <SidebarContent
            {...sidebarProps}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
          />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="sticky top-0 z-sticky flex h-12 items-center gap-2 border-b border-line bg-rail px-2 md:hidden">
            <IconButton label="Open menu" icon={<Menu />} onClick={() => setMobileOpen(true)} />
            <span className="min-w-0 flex-1 truncate text-ui font-semibold">
              {project?.name ?? data.organizationName ?? "Ratel"}
            </span>
            <IconButton label="Search" icon={<Search />} onClick={() => setCommandOpen(true)} />
          </div>
          {/* A screen ported unchanged brings its own layout and wants the padding; a design system
              <Page> (data-page) owns its edges. */}
          <main
            id="main-content"
            tabIndex={-1}
            className="min-w-0 flex-1 px-6 py-8 outline-none lg:px-10 has-[>[data-page]]:p-0"
          >
            {children}
          </main>
        </div>
      </div>

      <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-dialog bg-scrim transition-opacity duration-160 data-starting-style:opacity-0 data-ending-style:opacity-0 md:hidden" />
          <Dialog.Popup className="fixed inset-y-0 left-0 z-dialog w-[min(18rem,85vw)] border-r border-line bg-rail outline-none transition-[translate] duration-200 ease-enter data-starting-style:-translate-x-full data-ending-style:-translate-x-full motion-reduce:transition-none md:hidden">
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <SidebarContent
              {...sidebarProps}
              collapsed={false}
              onNavigate={() => setMobileOpen(false)}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} entries={entries} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} items={items} />
      <Toaster />
    </TooltipProvider>
  );
}
