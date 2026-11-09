import { test } from "node:test";
import ledger from "./ledger.json" with { type: "json" };

/**
 * The parity ledger (temporary parity harness, RTL-45): the audit's 28 items, each open or fixed.
 * A test of an open item still runs, and is reported as todo: it shows what is left without
 * failing the run. Once its fix lands and the item is flipped to fixed, the same test gates CI.
 * `PARITY_STRICT=1` runs every test as a gate, to see what an open item fails on.
 */

export type LedgerStatus = "open" | "fixed";
export interface LedgerItem {
  item: number;
  kind: "missing" | "wrong" | "cosmetic";
  title: string;
  status: LedgerStatus;
}

export const LEDGER: readonly LedgerItem[] = ledger.items as LedgerItem[];
const BY_ITEM = new Map(LEDGER.map((entry) => [entry.item, entry]));

/** A test that passes only when this repository answers as Cloud does, for one audit item. */
export function parity(item: number, name: string, run: () => void | Promise<void>): void {
  const entry = BY_ITEM.get(item);
  if (!entry)
    throw new Error(`parity test "${name}" names item ${item}, which the ledger does not have`);
  const title = `#${item} ${name}`;
  if (entry.status === "fixed" || process.env.PARITY_STRICT === "1") test(title, run);
  else test(title, { todo: `open: ${entry.title}` }, run);
}

/** Behaviour that already matches Cloud: it gates CI from the start, so a fix cannot break it. */
export function control(name: string, run: () => void | Promise<void>): void {
  test(`control: ${name}`, run);
}
