import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClosedTurn } from "@/lib/ledger/closed-turns";
import type { SignalTurn } from "./types";

/**
 * The ledger's closed-turn reader (owned, L3) and the detectors' turn shape (mirrored from
 * upstream, L4) are two declarations of one thing. That every closed turn is a signal turn
 * is checked at compile time here, so a drift in either file fails typecheck instead of a
 * job. (The detectors also accept drafts without `endedBy`, so the reverse need not hold.)
 */
test("a closed turn from the ledger is a signal turn", () => {
  const closed = {} as ClosedTurn;
  const signal: SignalTurn = closed;
  assert.equal(signal, closed);
});
