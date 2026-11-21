import { composition } from "@/lib/composition/ports";

/**
 * The product's full name where the MCP server introduces itself, from the edition's
 * `productName` when it has one, "Ratel" otherwise. Server-only: it reads the composition. The
 * short name, which copy shared with the browser uses, is `serviceName` in `app-config.ts`.
 */

/** The full name ("Ratel Cloud"); "Ratel" without an edition's. */
export function productName(): string {
  return composition.productName?.full ?? "Ratel";
}

/** The full name as a slug, for the MCP server's name and its 401 realm (`ratel-cloud`). */
export function productSlug(): string {
  return productName()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
