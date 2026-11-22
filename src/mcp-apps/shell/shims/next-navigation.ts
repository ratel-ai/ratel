/**
 * next/navigation inside a view (aliased by scripts/build-mcp-apps.mts).
 *
 * A view has no router and often no real URL (hosts load it from srcdoc or a
 * sandbox proxy, where history writes throw). The DS keeps UI state such as the
 * open Panel in the query string through `window.history.replaceState`, as Next
 * does, so this keeps an in-memory location: history writes update it instead
 * of navigating, and `useSearchParams` re-renders from it.
 */
import { useSyncExternalStore } from "react";

type Listener = () => void;

const listeners = new Set<Listener>();
let search = "";
let params = new URLSearchParams();

function setSearch(next: string): void {
  const normalized = next.startsWith("?") ? next.slice(1) : next;
  if (normalized === search) return;
  search = normalized;
  params = new URLSearchParams(search);
  for (const listener of listeners) listener();
}

/** The query part of a history URL ("/?peek=1", "?a=b", "/x"). */
export function searchOf(url: string | URL | null | undefined): string {
  if (url == null) return search;
  const text = String(url);
  const hash = text.indexOf("#");
  const withoutHash = hash === -1 ? text : text.slice(0, hash);
  const query = withoutHash.indexOf("?");
  return query === -1 ? "" : withoutHash.slice(query + 1);
}

let installed = false;

/** Route history writes into the in-memory location. Idempotent. */
export function installMemoryHistory(
  target: History | undefined = typeof window === "undefined" ? undefined : window.history,
): void {
  if (installed || !target) return;
  installed = true;
  const write = (_data: unknown, _unused: string, url?: string | URL | null) =>
    setSearch(searchOf(url));
  target.replaceState = write;
  target.pushState = write;
}

function subscribe(listener: Listener): () => void {
  installMemoryHistory();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePathname(): string {
  return "/";
}

export function useSearchParams(): URLSearchParams {
  return useSyncExternalStore(
    subscribe,
    () => params,
    () => params,
  );
}

export function useRouter() {
  return {
    push: (href: string) => setSearch(searchOf(href)),
    replace: (href: string) => setSearch(searchOf(href)),
    back: () => undefined,
    forward: () => undefined,
    refresh: () => undefined,
    prefetch: () => undefined,
  };
}

export function useParams(): Record<string, string> {
  return {};
}

export function notFound(): never {
  throw new Error("notFound() is not available inside an MCP view");
}

export function redirect(): never {
  throw new Error("redirect() is not available inside an MCP view");
}
