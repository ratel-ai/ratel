/**
 * Opening links from a view. The frame cannot navigate itself, so every link
 * leaves through the host (ui/open-link); the bridge installs the opener once
 * it is connected. Before that, or with no host (the harness), a new window.
 */

export const CONSOLE_ORIGIN = "https://cloud.ratel.sh";

/** Mirrors lib/mcp/server.ts CONSOLE_ORIGIN_META (a view cannot import server code). */
const ORIGIN_META = "ratel-console-origin";

/**
 * The console this view's links open: the origin of the app that served it,
 * which the server writes into the view's head (a local run is localhost,
 * staging is staging), else cloud.ratel.sh.
 */
export function consoleOrigin(
  doc: Pick<Document, "querySelector"> | undefined = typeof document === "undefined"
    ? undefined
    : document,
): string {
  const content = doc?.querySelector<HTMLMetaElement>(`meta[name="${ORIGIN_META}"]`)?.content;
  if (!content) return CONSOLE_ORIGIN;
  try {
    const url = new URL(content);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : CONSOLE_ORIGIN;
  } catch {
    return CONSOLE_ORIGIN;
  }
}

type Opener = (url: string) => void;

let opener: Opener | null = null;

export function setLinkOpener(next: Opener | null): void {
  opener = next;
}

/** Only http(s) leaves a view: never javascript:, data:, file: or a custom scheme. */
export function webUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function openExternal(url: string): void {
  const safe = webUrl(url);
  if (!safe) return;
  if (opener) opener(safe);
  else if (typeof window !== "undefined") window.open(safe, "_blank", "noopener,noreferrer");
}

/** A console path made absolute on the console; absolute URLs pass through. */
export function consoleUrl(href: string, origin: string = consoleOrigin()): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  return new URL(href, origin).toString();
}
