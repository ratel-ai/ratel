"use client";

import { IconButton } from "@ratel/design-system/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef } from "react";
import { type PageWindow, pageLabel } from "@/lib/console/catalog/paging";
import { toolsCatalogRangeLabel } from "@/lib/console/catalog/table-view";

/** Matches `scroll-mt-16` on the sections that hold a pager. */
const SCROLL_MARGIN_PX = 64;

/**
 * Previous and next under a long table, with where the reader is ("101–200 of
 * 1,234 · Page 2 of 13"). Hidden for one page. Turning a page brings the top of
 * the table back into view, since the reader is at the bottom of the last one.
 */
export function TablePager({
  window: range,
  total,
  onPage,
}: {
  window: PageWindow;
  total: number;
  onPage: (page: number) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  if (range.pageCount <= 1) return null;

  function turn(page: number) {
    onPage(page);
    // The section around the table; its scroll margin clears the mobile top bar.
    const table = ref.current?.parentElement;
    if (table && table.getBoundingClientRect().top < SCROLL_MARGIN_PX)
      table.scrollIntoView({ block: "start" });
  }

  return (
    <nav
      ref={ref}
      aria-label="Pages"
      className="flex items-center justify-end gap-1 text-xs text-fg-subtle tabular-nums"
    >
      <span className="mr-1">
        {toolsCatalogRangeLabel(range.offset, range.end - range.offset, total)}
        <span aria-hidden className="mx-1.5">
          ·
        </span>
        <span aria-current="page">{pageLabel(range)}</span>
      </span>
      <IconButton
        label="Previous page"
        icon={<ChevronLeft />}
        size="icon-sm"
        disabled={range.page <= 1}
        onClick={() => turn(range.page - 1)}
      />
      <IconButton
        label="Next page"
        icon={<ChevronRight />}
        size="icon-sm"
        disabled={range.page >= range.pageCount}
        onClick={() => turn(range.page + 1)}
      />
    </nav>
  );
}
