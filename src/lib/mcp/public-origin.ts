import { isLocalEnvironment } from "@/lib/platform/environment";
import { publicBaseUrl } from "@/lib/platform/public-url";

/**
 * The origin an MCP client actually reached us on.
 *
 * OAuth discovery is a chain of absolute URLs: the 401 names a metadata
 * document, the document names an authorization server. Every hop has to stay
 * on the origin the client started from. Point one hop somewhere else and the
 * client follows it, finds something that is not this server, and gives up
 * silently: the visible symptom is a terminal that says a browser window will
 * open and then nothing happens.
 *
 * `publicUrl()` is wrong for this, because it falls back to a hardcoded
 * `http://localhost:3000` when `APP_PUBLIC_URL` is unset. That default is fine
 * for rendering a copyable snippet and fatal here, since a developer running on
 * any other port gets sent to a different server.
 *
 * So: the configured origin wins when it exists (production and staging set it,
 * and it is the authority on what the public URL is), and otherwise the request
 * answers for itself. That ordering also keeps the header untrusted in the one
 * environment where trusting it would matter, because production always has
 * `APP_PUBLIC_URL` set and never reaches the fallback.
 */
export function mcpOrigin(request: Request): string {
  const configured = process.env.APP_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  // Deployed without it: refuse (publicBaseUrl throws) rather than trust headers.
  if (!isLocalEnvironment(process.env)) return publicBaseUrl();

  // Local development. A proxy in front (a tunnel, `next dev` behind something)
  // rewrites the host, so prefer what it forwarded over the socket-level URL.
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    const proto = request.headers.get("x-forwarded-proto") ?? "http";
    return `${proto}://${forwardedHost}`;
  }
  return new URL(request.url).origin;
}

/** The MCP endpoint's own identifier, which RFC 9728 calls the resource. */
export function mcpResourceUrl(request: Request): string {
  return `${mcpOrigin(request)}/api/mcp`;
}

/**
 * Where the protected resource metadata lives.
 *
 * RFC 9728 inserts the resource's path after the well-known segment, so the
 * document for `/api/mcp` is served at
 * `/.well-known/oauth-protected-resource/api/mcp`.
 */
export function mcpResourceMetadataUrl(request: Request): string {
  return `${mcpOrigin(request)}/.well-known/oauth-protected-resource/api/mcp`;
}

/**
 * The same origin, for a Server Component that has no `Request` in hand.
 *
 * The connect page renders the endpoint people copy, so it has the identical
 * requirement: show the origin they are actually browsing, not a compile-time
 * default. Getting this wrong is worse here than anywhere else, because the
 * reader pastes it into a terminal and the failure surfaces minutes later as a
 * client that hangs, with nothing pointing back at this page.
 */
export async function mcpOriginFromHeaders(): Promise<string> {
  const configured = process.env.APP_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  // Deployed without it: refuse (publicBaseUrl throws) rather than trust headers.
  if (!isLocalEnvironment(process.env)) return publicBaseUrl();

  const { headers } = await import("next/headers");
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  if (!host) {
    // Guessing here is what the whole module exists to stop. Every real request
    // carries a Host, so this means something is badly wrong upstream, and a
    // plausible-looking wrong origin would send clients somewhere else entirely.
    throw new Error(
      "Cannot determine the public origin: no Host header and APP_PUBLIC_URL is unset.",
    );
  }

  const proto =
    headerList.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}
