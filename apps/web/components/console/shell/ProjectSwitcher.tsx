"use client";

import { BadgerMark } from "@ratel/design-system/badger-mark";
import { cn } from "@ratel/design-system/cn";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@ratel/design-system/menu";
import { Building2, Check, ChevronsUpDown, FolderClosed, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { newProjectHref, organizationRoot, switchProjectHref } from "@/lib/console/navigation";
import type { ConsoleProject } from "@/lib/console/shell-data";

const TRIGGER =
  "flex h-9 min-w-0 items-center gap-2 rounded-md px-1.5 text-left outline-none transition-colors duration-120 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus";

/**
 * The top of the rail: the brand, where you are, and the way to the organization's other
 * projects. Switching project keeps the section you were reading. One organization.
 */
export function ProjectSwitcher({
  organizationName,
  organizationSlug,
  projects,
  project,
  collapsed,
}: {
  organizationName: string | null;
  organizationSlug: string | null;
  projects: readonly ConsoleProject[];
  project: ConsoleProject | undefined;
  collapsed: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const title = project?.name ?? organizationName ?? "Ratel";
  const subtitle = project ? (organizationName ?? undefined) : undefined;
  const label = (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center">
        <BadgerMark className="h-3.5 w-auto text-brand-cream" />
      </span>
      {collapsed ? null : (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-semibold text-fg">{title}</span>
          {subtitle ? (
            <span className="block truncate text-xs text-fg-subtle">{subtitle}</span>
          ) : null}
        </span>
      )}
    </>
  );
  const width = collapsed ? "w-9 justify-center px-0" : "flex-1";

  if (!organizationSlug) {
    return (
      <Link href="/" aria-label={`${title} home`} className={cn(TRIGGER, width)}>
        {label}
      </Link>
    );
  }

  const search = params.toString();
  const root = organizationRoot(organizationSlug);
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Switch project. Current: ${title}`}
        className={cn(TRIGGER, width, "data-popup-open:bg-hover")}
      >
        {label}
        {collapsed ? null : (
          <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
        )}
      </MenuTrigger>
      <MenuContent className="w-64">
        <MenuGroup label={organizationName ?? undefined}>
          {projects.map((candidate) => (
            <MenuItem
              key={candidate.id}
              icon={candidate.id === project?.id ? <Check /> : <FolderClosed />}
              onClick={() =>
                router.push(
                  switchProjectHref(search ? `${pathname}?${search}` : pathname, candidate.id),
                )
              }
            >
              {candidate.name}
            </MenuItem>
          ))}
        </MenuGroup>
        {projects.length > 0 ? <MenuSeparator /> : null}
        <MenuItem icon={<Building2 />} onClick={() => router.push(root)}>
          All projects
        </MenuItem>
        <MenuItem icon={<Plus />} onClick={() => router.push(newProjectHref(root))}>
          New project
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
