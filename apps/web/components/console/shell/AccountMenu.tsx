"use client";

import { cn } from "@ratel/design-system/cn";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ratel/design-system/menu";
import { BookOpen, Keyboard } from "lucide-react";
import type { ConsoleAccount } from "@/lib/console/shell-data";

const DOCS_URL = "https://docs.ratel.sh";

/** The foot of the rail: who is signed in, the docs and the shortcuts. */
export function AccountMenu({
  account,
  collapsed,
  onShortcuts,
}: {
  account: ConsoleAccount;
  collapsed: boolean;
  onShortcuts: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Account menu for ${account.name}`}
        className={cn(
          "flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left outline-none transition-colors duration-120 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus data-popup-open:bg-hover",
          collapsed && "justify-center px-0",
        )}
      >
        <Avatar name={account.name} />
        {collapsed ? null : (
          <span className="min-w-0 flex-1 truncate text-ui text-fg-muted">{account.name}</span>
        )}
      </MenuTrigger>
      <MenuContent side="top" align="start" className="w-60">
        <div className="px-2 pt-1.5 pb-2">
          <p className="truncate text-ui font-medium text-fg">{account.name}</p>
          {account.email ? (
            <p className="truncate text-xs text-fg-subtle">{account.email}</p>
          ) : null}
        </div>
        <MenuSeparator />
        <MenuItem
          icon={<BookOpen />}
          onClick={() => window.open(DOCS_URL, "_blank", "noopener,noreferrer")}
        >
          Documentation
        </MenuItem>
        <MenuItem icon={<Keyboard />} shortcut="?" onClick={onShortcuts}>
          Keyboard shortcuts
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-selected text-xs font-medium text-fg-muted"
    >
      {initials || "?"}
    </span>
  );
}
