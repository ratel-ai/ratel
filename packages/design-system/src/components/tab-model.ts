/**
 * Pure tab logic, kept out of the client component so tests can call it (a
 * function exported from a "use client" module is a client reference on the
 * server).
 */

/**
 * Whether a tab link is the current page. A tab may carry the page's query
 * (filters, time window) to the next tab, so only its path decides. A link
 * that is only a query or a hash stays on this page, so its path is this one.
 */
export function isCurrentTab(href: string, pathname: string, exact = false): boolean {
  const path = href.split(/[?#]/)[0] || pathname;
  return exact ? pathname === path : pathname === path || pathname.startsWith(`${path}/`);
}
