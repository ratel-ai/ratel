/**
 * next/link inside a view (aliased by scripts/build-mcp-apps.mts).
 *
 * A console path ("/projects/…") means nothing inside a host's iframe, so a
 * link becomes a plain <a> to the same page on the console, and a click asks
 * the host to open it (ui/open-link) instead of navigating the frame. Query-
 * only links ("?peek=…", the DS's in-place Panels) stay in the view.
 */
import { type AnchorHTMLAttributes, forwardRef, type MouseEvent, type ReactNode } from "react";
import { consoleUrl, openExternal, webUrl } from "../links";

type Href =
  | string
  | {
      pathname?: string | null;
      search?: string | null;
      hash?: string | null;
      query?: Record<string, unknown>;
    };

export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: Href;
  prefetch?: boolean | null;
  replace?: boolean;
  scroll?: boolean;
  shallow?: boolean;
  passHref?: boolean;
  legacyBehavior?: boolean;
  locale?: string | false;
  children?: ReactNode;
};

function hrefText(href: Href): string {
  if (typeof href === "string") return href;
  const query = href.query
    ? `?${new URLSearchParams(Object.entries(href.query).map(([key, value]) => [key, String(value)])).toString()}`
    : (href.search ?? "");
  return `${href.pathname ?? ""}${query}${href.hash ?? ""}`;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  // Next-only props are dropped so they never reach the DOM.
  {
    href,
    prefetch: _prefetch,
    replace: _replace,
    scroll: _scroll,
    shallow: _shallow,
    passHref: _passHref,
    legacyBehavior: _legacy,
    locale: _locale,
    onClick,
    children,
    ...rest
  },
  ref,
) {
  const text = hrefText(href);
  const local = text.startsWith("?") || text.startsWith("#");
  // Anything but http(s) renders without a destination: a click does nothing.
  const target = local ? text : webUrl(consoleUrl(text));
  return (
    <a
      ref={ref}
      {...rest}
      {...(target ? { href: target } : {})}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented || local) return;
        event.preventDefault();
        if (target) openExternal(target);
      }}
    >
      {children}
    </a>
  );
});

export default Link;
