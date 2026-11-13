/**
 * Paging for the Catalog tables (DESIGN.md, Lists: more than 200 rows are
 * paged). One page holds 100 rows, so the demo and typical catalogs fit on one
 * page and an MCP-heavy project with thousands of tools stays fast. The page
 * lives in `?page=`, the parameter the v1 tools table already used.
 */

export const CATALOG_PAGE_SIZE = 100;

export interface PageWindow {
  /** 1-based, clamped to the pages that exist. */
  page: number;
  pageCount: number;
  /** First row index on the page. */
  offset: number;
  /** One past the last row index on the page. */
  end: number;
}

/** A positive whole page number from the URL, else 1. */
export function parsePage(value: string | null | undefined): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

/** The rows `requested` shows out of `total`, never past the last page. */
export function pageWindow(
  total: number,
  requested: number,
  pageSize: number = CATALOG_PAGE_SIZE,
): PageWindow {
  const pageCount = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  const page = Math.min(Math.max(1, requested), pageCount);
  const offset = (page - 1) * pageSize;
  return { page, pageCount, offset, end: Math.min(total, offset + pageSize) };
}

/** "Page 2 of 13". */
export function pageLabel(range: Pick<PageWindow, "page" | "pageCount">): string {
  return `Page ${range.page.toLocaleString("en-US")} of ${range.pageCount.toLocaleString("en-US")}`;
}
