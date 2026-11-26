/**
 * The app's canonical public origin — always from the configuration, never a
 * hardcoded host. `app.publicUrl` (APP_PUBLIC_URL) is the explicit knob (set in `.env` locally
 * and on the ECS task's env in AWS, where it resolves to `https://<domain>`,
 * e.g. https://ratel.example.com). It falls back to localhost so a bare `next dev`
 * still produces working links.
 *
 * Server-only: reads the server's configuration, so call it in Server Components /
 * route handlers / server actions and pass the result down to client components
 * as a prop (the Settings and Embeddings pages already do).
 */

import { getConfig } from "@/config";
import { isLocalEnvironment } from "@/lib/platform/environment";

const DEFAULT_LOCAL = "http://localhost:3000";

/**
 * The origin with any trailing slash stripped, e.g. `https://ratel.example.com`.
 * Outside a local environment an unset `APP_PUBLIC_URL` throws instead of
 * falling back: a deployed invitation pointing at localhost fails silently,
 * a page that errors does not.
 */
export function publicBaseUrl(): string {
  const configured = getConfig().app.publicUrl;
  if (!configured && !isLocalEnvironment()) {
    throw new Error("APP_PUBLIC_URL is not set: a deployed environment needs its public origin");
  }
  return (configured || DEFAULT_LOCAL).replace(/\/+$/, "");
}

/** An absolute URL under the public origin, e.g. `publicUrl("/v1/embeddings")`. */
export function publicUrl(path: string): string {
  const base = publicBaseUrl();
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

/**
 * Where a route handler's redirect points. Behind the load balancer Next builds
 * `request.url` from the container's own address, so `new URL(path, request.url)`
 * sends the browser to `https://ip-10-…compute.internal:3000/…` (Next only makes
 * the proxy's redirects relative, never a route handler's). The configured
 * public origin wins; the request's own origin answers only when it is unset
 * in a local environment, so `next dev` on any port still redirects to itself.
 */
export function redirectUrl(path: string, requestUrl: string): URL {
  const local = !getConfig().app.publicUrl && isLocalEnvironment();
  return new URL(path, local ? requestUrl : publicBaseUrl());
}

/**
 * Whether a request's `Origin` header names this app. Checked against the
 * public origin, because behind the load balancer `req.url` carries the
 * container's own address (http://<task>:3000), never the domain the browser
 * used. The request URL's origin still counts, for `next dev` and previews.
 */
export function isOwnOrigin(origin: string, requestUrl: string): boolean {
  return origin === publicBaseUrl() || origin === new URL(requestUrl).origin;
}
