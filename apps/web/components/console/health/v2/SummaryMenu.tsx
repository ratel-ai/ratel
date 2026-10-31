"use client";

import { IconButton } from "@ratel/design-system/button";
import { Menu, MenuContent, MenuLinkItem, MenuTrigger } from "@ratel/design-system/menu";
import { Ellipsis, FileDown } from "lucide-react";

/**
 * The page's actions in one menu beside the window. Owned (ADR-0030): upstream also offers the
 * importer and a public share link here; this edition has neither, so the menu holds the PDF
 * report and is absent without one.
 */
export function SummaryMenu({
  reportHref,
}: {
  /** The printable report for this window; null hides the menu. */
  reportHref: string | null;
}) {
  if (!reportHref) return null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            label={menuLabel({ report: true })}
            variant="secondary"
            icon={<Ellipsis />}
            data-health-menu=""
          />
        }
      />
      <MenuContent align="end">
        <MenuLinkItem
          icon={<FileDown strokeWidth={1.5} />}
          href={reportHref}
          target="_blank"
          rel="noopener"
          closeOnClick
        >
          Download PDF
        </MenuLinkItem>
      </MenuContent>
    </Menu>
  );
}

/** The trigger's name: what the menu holds. */
export function menuLabel({ report }: { report: boolean }): string {
  return report ? "Download" : "";
}
