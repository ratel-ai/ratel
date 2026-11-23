"use client";

import { Badge } from "@ratel/design-system/badge";
import { IconButton } from "@ratel/design-system/button";
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuTrigger } from "@ratel/design-system/menu";
import { Ellipsis, FileDown, Import, Share2 } from "lucide-react";
import { openHealthImport } from "@/components/console/health/imports/open-import";
import { openHealthShare } from "@/components/console/health/share/open-share";

/**
 * The page's actions in one menu beside the window: import past runs (the
 * importer is mounted on the page), the PDF report, and sharing a read-only
 * copy. Owned (ADR-0004): the importer and the share dialog are the edition's
 * (`EditionUi.HealthImports`, `EditionUi.HealthShare`), mounted by the page
 * and opened from here by a window event; without them the items are absent.
 */
export function SummaryMenu({
  reportHref,
  canImport,
  share,
}: {
  /** The printable report for this window; null hides it. */
  reportHref: string | null;
  canImport: boolean;
  /** Null when sharing is not offered (no edition dialog, or its read failed). */
  share: { linkOn: boolean } | null;
}) {
  if (!canImport && !reportHref && !share) return null;
  const label = menuLabel({ canImport, report: reportHref !== null, share: share !== null });
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
        {share ? (
          <MenuItem
            icon={<Share2 strokeWidth={1.5} />}
            onClick={openHealthShare}
            data-health-share-open=""
          >
            <span className="flex items-center justify-between gap-3">
              Share…
              {share.linkOn ? <Badge tone="success">Link on</Badge> : null}
            </span>
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

/** The trigger's name: what the menu holds, "Import, download and share" at most. */
export function menuLabel({
  canImport,
  report,
  share = false,
}: {
  canImport: boolean;
  report: boolean;
  share?: boolean;
}): string {
  const parts = [
    canImport ? "import" : null,
    report ? "download" : null,
    share ? "share" : null,
  ].filter((part): part is string => part !== null);
  const text =
    parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
