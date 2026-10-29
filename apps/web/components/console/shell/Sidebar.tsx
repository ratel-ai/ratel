"use client";

import { IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Tooltip } from "@ratel/design-system/tooltip";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import type { NavItem } from "@/lib/console/navigation";
import type { ConsoleProject } from "@/lib/console/shell-data";
import { NAV_ICONS } from "./nav-icons";
import { ProjectSwitcher } from "./ProjectSwitcher";

export type SidebarProps = {
  items: readonly NavItem[];
  activeId: string | null;
  organizationName: string | null;
  projects: readonly ConsoleProject[];
  project: ConsoleProject | undefined;
  collapsed: boolean;
  /** Absent in the mobile drawer, which is always expanded. */
  onToggleCollapsed?: () => void;
  /** Called when a link is followed, so the mobile drawer can close. */
  onNavigate?: () => void;
};

/**
 * The left of the inverted L (DESIGN.md, Layout): where you are and the flat rail. Dimmer than
 * the page; the selection mark is the only color on it.
 */
export function SidebarContent({
  items,
  activeId,
  organizationName,
  projects,
  project,
  collapsed,
  onToggleCollapsed,
  onNavigate,
}: SidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={cn("flex h-13 shrink-0 items-center gap-1 px-2", collapsed && "justify-center")}
      >
        <ProjectSwitcher
          organizationName={organizationName}
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

      {onToggleCollapsed && collapsed ? (
        <div className="flex shrink-0 flex-col items-center px-2 pb-2">
          <IconButton
            label="Expand sidebar"
            shortcut="["
            size="icon-sm"
            icon={<PanelLeftOpen />}
            onClick={onToggleCollapsed}
          />
        </div>
      ) : null}

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
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  );
}
