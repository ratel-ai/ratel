"use client";

import { IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Kbd } from "@ratel/design-system/kbd";
import { Tooltip } from "@ratel/design-system/tooltip";
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import Link from "next/link";
import type { NavItem } from "@/lib/console/navigation";
import type { ConsoleAccount, ConsoleProject } from "@/lib/console/shell-data";
import { AccountMenu } from "./AccountMenu";
import { NAV_ICONS } from "./nav-icons";
import { ProjectSwitcher } from "./ProjectSwitcher";

export type SidebarProps = {
  items: readonly NavItem[];
  activeId: string | null;
  organizationName: string | null;
  organizationSlug: string | null;
  projects: readonly ConsoleProject[];
  project: ConsoleProject | undefined;
  account: ConsoleAccount | null;
  collapsed: boolean;
  /** Absent in the mobile drawer, which is always expanded. */
  onToggleCollapsed?: () => void;
  onSearch: () => void;
  onShortcuts: () => void;
  /** Called when a link is followed, so the mobile drawer can close. */
  onNavigate?: () => void;
};

/**
 * The left of the inverted L (DESIGN.md, Layout): where you are, search, the flat rail, and you. Dimmer than
 * the page; the selection mark is the only color on it.
 */
export function SidebarContent({
  items,
  activeId,
  organizationName,
  organizationSlug,
  projects,
  project,
  account,
  collapsed,
  onToggleCollapsed,
  onSearch,
  onShortcuts,
  onNavigate,
}: SidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={cn("flex h-13 shrink-0 items-center gap-1 px-2", collapsed && "justify-center")}
      >
        <ProjectSwitcher
          organizationName={organizationName}
          organizationSlug={organizationSlug}
          projects={projects}
          project={project}
          collapsed={collapsed}
        />
        {onToggleCollapsed && !collapsed ? (
          <IconButton
            label="Collapse sidebar"
            shortcut="["
            size="icon-sm"
            icon={<PanelLeftClose />}
            onClick={onToggleCollapsed}
          />
        ) : null}
      </div>

      <div className={cn("flex shrink-0 flex-col gap-1 px-2 pb-2", collapsed && "items-center")}>
        {onToggleCollapsed && collapsed ? (
          <IconButton
            label="Expand sidebar"
            shortcut="["
            size="icon-sm"
            icon={<PanelLeftOpen />}
            onClick={onToggleCollapsed}
          />
        ) : null}
        {collapsed ? (
          <IconButton
            label="Search"
            shortcut="⌘K"
            size="icon-sm"
            icon={<Search />}
            onClick={onSearch}
          />
        ) : (
          <button
            type="button"
            onClick={onSearch}
            className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-app px-2 text-ui text-fg-subtle outline-none transition-colors duration-120 hover:border-line-strong hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="flex-1 text-left">Search…</span>
            <Kbd>⌘K</Kbd>
          </button>
        )}
      </div>

      <nav
        aria-label={project ? "Project" : "Console"}
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 py-1",
          collapsed && "items-center",
        )}
      >
        {items.map((item) => (
          <RailLink
            key={item.id}
            item={item}
            active={item.id === activeId}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      {account ? (
        <div className="shrink-0 border-t border-line p-2">
          <AccountMenu account={account} collapsed={collapsed} onShortcuts={onShortcuts} />
        </div>
      ) : null}
    </div>
  );
}

function RailLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = NAV_ICONS[item.icon];
  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
      onClick={onNavigate}
      className={cn(
        "group flex h-8 items-center gap-2 rounded-md px-2 text-ui font-medium outline-none transition-colors duration-120 focus-visible:ring-2 focus-visible:ring-focus",
        collapsed && "w-8 justify-center px-0",
        active ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
      )}
    >
      <Icon
        aria-hidden
        strokeWidth={1.5}
        className={cn(
          "size-4 shrink-0 transition-colors duration-120",
          active ? "text-accent-mark" : "text-fg-subtle group-hover:text-fg-muted",
        )}
      />
      {collapsed ? null : <span className="truncate">{item.label}</span>}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip
      content={item.label}
      side="right"
      shortcut={item.shortcut ? `G ${item.shortcut.toUpperCase()}` : undefined}
    >
      {link}
    </Tooltip>
  );
}
