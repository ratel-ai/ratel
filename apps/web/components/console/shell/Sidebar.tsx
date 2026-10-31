"use client";

import { IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Kbd } from "@ratel/design-system/kbd";
import { Tooltip } from "@ratel/design-system/tooltip";
import { ChevronRight, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
 * The left of the inverted L (DESIGN.md, Layout): where you are, search, the rail, and you. Dimmer than
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
          "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-2 py-1",
          collapsed && "items-center",
        )}
      >
        {sections(items).map(({ id, items: sectionItems }) => (
          <div key={id} className={cn("flex flex-col gap-0.5", collapsed && "items-center")}>
            {sectionItems.map((item) =>
              item.children?.length && !collapsed ? (
                <RailGroup key={item.id} item={item} activeId={activeId} onNavigate={onNavigate} />
              ) : (
                <RailLink
                  key={item.id}
                  item={item}
                  active={
                    item.id === activeId ||
                    Boolean(item.children?.some(({ id: childId }) => childId === activeId))
                  }
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              ),
            )}
          </div>
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

/** Consecutive items of one section, in rail order. */
function sections(items: readonly NavItem[]): { id: string; items: NavItem[] }[] {
  const out: { id: string; items: NavItem[] }[] = [];
  for (const item of items) {
    const id = item.section ?? "main";
    const last = out.at(-1);
    if (last?.id === id) last.items.push(item);
    else out.push({ id, items: [item] });
  }
  return out;
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

/**
 * An item with sub-pages. The row opens the group's landing page; the chevron folds the children
 * without navigating. Open while you are anywhere inside the group, so the rail shows where you are.
 */
function RailGroup({
  item,
  activeId,
  onNavigate,
}: {
  item: NavItem;
  activeId: string | null;
  onNavigate?: () => void;
}) {
  const children = item.children ?? [];
  const inside = item.id === activeId || children.some((child) => child.id === activeId);
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? inside;
  const Icon = NAV_ICONS[item.icon];
  return (
    <div className="flex flex-col">
      <div className="group relative flex items-center">
        <Link
          href={item.href}
          aria-current={item.id === activeId ? "page" : undefined}
          onClick={() => {
            setToggled(true);
            onNavigate?.();
          }}
          className={cn(
            "flex h-8 flex-1 items-center gap-2 rounded-md pr-8 pl-2 text-ui font-medium outline-none transition-colors duration-120 focus-visible:ring-2 focus-visible:ring-focus",
            item.id === activeId
              ? "bg-selected text-fg"
              : "text-fg-muted hover:bg-hover hover:text-fg",
          )}
        >
          <Icon
            aria-hidden
            strokeWidth={1.5}
            className={cn(
              "size-4 shrink-0 transition-colors duration-120",
              inside ? "text-accent-mark" : "text-fg-subtle group-hover:text-fg-muted",
            )}
          />
          <span className="truncate">{item.label}</span>
        </Link>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Collapse ${item.label}` : `Expand ${item.label}`}
          onClick={() => setToggled(!open)}
          className="absolute right-1 inline-flex size-6 items-center justify-center rounded text-fg-subtle outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 transition-transform duration-160 ease-enter motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        </button>
      </div>
      {/* Grid rows animate to the content's own height; inert keeps folded links out of the tab order. */}
      <div
        className={cn(
          "grid overflow-hidden transition-[grid-template-rows] duration-200 ease-enter motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
        inert={!open}
      >
        <div className="min-h-0">
          <ul className="ml-[17px] flex flex-col gap-0.5 border-l border-line pt-0.5 pl-2">
            {children.map((child) => {
              const active = child.id === activeId;
              return (
                <li key={child.id}>
                  <Link
                    href={child.href}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(
                      "flex h-7 items-center gap-2 rounded-md px-2 text-ui outline-none transition-colors duration-120 focus-visible:ring-2 focus-visible:ring-focus",
                      active
                        ? "bg-selected font-medium text-fg"
                        : "text-fg-muted hover:bg-hover hover:text-fg",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-1 shrink-0 rounded-full",
                        active ? "bg-accent-mark" : "bg-line-strong",
                      )}
                    />
                    <span className="truncate">{child.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
