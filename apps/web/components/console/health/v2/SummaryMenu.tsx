"use client";

import { IconButton } from "@ratel/design-system/button";
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuTrigger } from "@ratel/design-system/menu";
import { Ellipsis, FileDown, Import } from "lucide-react";
import { openHealthImport } from "@/components/console/health/imports/open-import";

/**
 * The page's actions in one menu beside the window: import past runs (the
 * importer is mounted on the page) and the PDF report. Owned (ADR-0030):
 * upstream also shares a public link here; this edition has none, and the
 * importer is the edition's (`EditionUi.HealthImports`).
 */
export function SummaryMenu({
  reportHref,
  canImport,
}: {
  /** The printable report for this window; null hides it. */
  reportHref: string | null;
  canImport: boolean;
}) {
  if (!canImport && !reportHref) return null;
  const label = menuLabel({ canImport, report: reportHref !== null });
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton label={label} variant="secondary" icon={<Ellipsis />} data-health-menu="" />
        }
      />
      <MenuContent align="end">
        {canImport ? (
          <MenuItem
            icon={<Import strokeWidth={1.5} />}
            onClick={openHealthImport}
            data-health-open-import=""
          >
            Import past runs
          </MenuItem>
        ) : null}
        {reportHref ? (
          <MenuLinkItem
            icon={<FileDown strokeWidth={1.5} />}
            href={reportHref}
            target="_blank"
            rel="noopener"
            closeOnClick
          >
            Download PDF
          </MenuLinkItem>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

/** The trigger's name: what the menu holds, "Import and download" at most. */
export function menuLabel({ canImport, report }: { canImport: boolean; report: boolean }): string {
  const parts = [canImport ? "import" : null, report ? "download" : null].filter(
    (part): part is string => part !== null,
  );
  const text =
    parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
