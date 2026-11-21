import type { FixShipmentRow } from "@/lib/views/fixes/schema";
import type { Fix } from "@/lib/views/fixes/types";
import { hrefFor, shipmentRef } from "@/lib/views/lineage/refs";

/**
 * Whether a fix shipped (RC-72): `mark_fix_shipped` wrote a `fix_shipments`
 * row for it. Derived from those rows, never stored on the fix, so Fixes and
 * the MCP tools read the same answer. Pure and client-safe.
 */

export interface FixShipped {
  shipmentId: string;
  /** The agent version or release the fix went out in, as recorded. */
  version: string;
  /** ISO time it was recorded as shipped. */
  shippedAt: string;
  /** The shipment on Ship (`?peek=<id>`), with its trail. */
  href: string;
}

/** Each fix's newest shipment, by the fix id it was recorded under. */
export function shippedByFix(
  projectId: string,
  rows: readonly Pick<FixShipmentRow, "id" | "fixId" | "version" | "shippedAt">[],
): Record<string, FixShipped> {
  const out: Record<string, FixShipped> = {};
  for (const row of rows) {
    const shippedAt = row.shippedAt.toISOString();
    const known = out[row.fixId];
    if (known && known.shippedAt >= shippedAt) continue;
    out[row.fixId] = {
      shipmentId: row.id,
      version: row.version,
      shippedAt,
      href: hrefFor(shipmentRef(row.id), projectId) ?? "",
    };
  }
  return out;
}

/** The fix's newest shipment, under its id or any id merged into it; null when it has not shipped. */
export function shippedFor(
  shipped: Readonly<Record<string, FixShipped>> | null | undefined,
  fix: Pick<Fix, "id" | "aliases">,
): FixShipped | null {
  if (!shipped) return null;
  let best: FixShipped | null = shipped[fix.id] ?? null;
  for (const alias of fix.aliases) {
    const other = shipped[alias];
    if (other && (!best || other.shippedAt > best.shippedAt)) best = other;
  }
  return best;
}

/** "Shipped in v2.5.0": the status word with its version. */
export function shippedLabel(shipped: Pick<FixShipped, "version">): string {
  return `Shipped in ${shipped.version}`;
}
