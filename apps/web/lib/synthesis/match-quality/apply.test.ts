import assert from "node:assert/strict";
import { test } from "node:test";
import type { MatchQualityProposalRow } from "@/lib/synthesis/match-quality/schema";
import {
  type ApplyDeps,
  applyProposal,
  applyProposals,
  dismissProposal,
  revertProposal,
} from "./apply";

const NOW = new Date("2026-09-14T12:00:00Z");
const PROJECT = "22222222-2222-4222-8222-222222222222";

function proposalRow(overrides: Partial<MatchQualityProposalRow> = {}): MatchQualityProposalRow {
  return {
    id: "p1",
    runId: "r1",
    projectId: PROJECT,
    entryId: "refund_payment",
    entryName: "refund_payment",
    status: "pending",
    currentSearchable: "Reverses a ledger entry.",
    currentSource: "runtime",
    proposedSearchable: "Refunds a payment. Use when the customer asks for money back.",
    rationale: "because",
    evidence: {},
    preview: {},
    backtest: null,
    appliedAt: null,
    appliedBy: null,
    revertedAt: null,
    previousOverride: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as MatchQualityProposalRow;
}

/** A tiny in-memory catalog + proposal store that honours the CAS semantics. */
function harness(
  options: {
    overrides?: Record<string, string | null>;
    proposals?: MatchQualityProposalRow[];
  } = {},
) {
  const catalog = new Map<string, string | null>(
    Object.entries(options.overrides ?? { refund_payment: null }),
  );
  const proposals = new Map(
    (options.proposals ?? [proposalRow()]).map((row) => [row.id, { ...row }]),
  );
  const writes: Array<{ entryId: string; value: string | null }> = [];

  const deps: ApplyDeps = {
    now: () => NOW,
    logError: () => {},
    getProposal: async (_projectId, proposalId) => proposals.get(proposalId) ?? null,
    swapOverride: async (_projectId, entryId, value) => {
      if (!catalog.has(entryId)) return undefined;
      const previous = catalog.get(entryId) ?? null;
      catalog.set(entryId, value);
      writes.push({ entryId, value });
      return { previous };
    },
    transitionProposal: async (proposalId, from, to, extra) => {
      const row = proposals.get(proposalId);
      if (!row || row.status !== from) return false;
      proposals.set(proposalId, {
        ...row,
        status: to,
        ...(extra ?? {}),
      } as MatchQualityProposalRow);
      return true;
    },
  };
  return { catalog, proposals, writes, deps };
}

test("applying writes the proposed text through the shared override path", async () => {
  const h = harness();
  const outcome = await applyProposal(PROJECT, "p1", "user_1", h.deps);
  assert.deepEqual(outcome, { ok: true, status: "applied" });
  assert.equal(
    h.catalog.get("refund_payment"),
    "Refunds a payment. Use when the customer asks for money back.",
  );
  assert.equal(h.proposals.get("p1")?.status, "applied");
  assert.equal(h.proposals.get("p1")?.appliedBy, "user_1");
});

test("reverting restores an operator's earlier text rather than clearing it", async () => {
  const h = harness({ overrides: { refund_payment: "hand written by an operator" } });
  await applyProposal(PROJECT, "p1", "user_1", h.deps);
  assert.equal(h.proposals.get("p1")?.previousOverride, "hand written by an operator");

  const reverted = await revertProposal(PROJECT, "p1", h.deps);
  assert.deepEqual(reverted, { ok: true, status: "reverted" });
  assert.equal(h.catalog.get("refund_payment"), "hand written by an operator");
});

test("reverting an entry that had no override restores it to none, not to empty text", async () => {
  const h = harness({ overrides: { refund_payment: null } });
  await applyProposal(PROJECT, "p1", "user_1", h.deps);
  await revertProposal(PROJECT, "p1", h.deps);
  assert.equal(h.catalog.get("refund_payment"), null);
});

test("a second operator applying the same proposal changes nothing", async () => {
  const h = harness({ overrides: { refund_payment: "original" } });
  const first = await applyProposal(PROJECT, "p1", "user_1", h.deps);
  const second = await applyProposal(PROJECT, "p1", "user_2", h.deps);
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: "not_pending" });
  // The loser must not have overwritten what revert will restore.
  assert.equal(h.proposals.get("p1")?.previousOverride, "original");
  assert.equal(h.writes.length, 1);
});

test("an entry removed by a re-sync fails cleanly and leaves the proposal pending", async () => {
  const h = harness({ overrides: {} });
  const outcome = await applyProposal(PROJECT, "p1", "user_1", h.deps);
  assert.deepEqual(outcome, { ok: false, reason: "entry_gone" });
  assert.equal(h.proposals.get("p1")?.status, "pending");
});

test("an entry that disappears mid-apply puts the proposal back rather than claiming success", async () => {
  const h = harness();
  const deps: ApplyDeps = { ...h.deps, swapOverride: async () => undefined };
  const outcome = await applyProposal(PROJECT, "p1", "user_1", deps);
  assert.deepEqual(outcome, { ok: false, reason: "entry_gone" });
  assert.equal(h.proposals.get("p1")?.status, "pending");
});

test("a throwing write releases the claim and rethrows", async () => {
  const h = harness();
  const deps: ApplyDeps = {
    ...h.deps,
    swapOverride: async () => {
      throw new Error("connection reset");
    },
  };
  await assert.rejects(() => applyProposal(PROJECT, "p1", "user_1", deps), /connection reset/);
  const row = h.proposals.get("p1");
  assert.equal(row?.status, "pending", "it stays actionable");
  assert.equal(row?.appliedBy, null, "and does not read as applied by anyone");
  assert.equal(row?.appliedAt, null);
  assert.equal(row?.previousOverride, null);
});

test("dismissing leaves the catalog untouched", async () => {
  const h = harness();
  const outcome = await dismissProposal(PROJECT, "p1", h.deps);
  assert.deepEqual(outcome, { ok: true, status: "dismissed" });
  assert.equal(h.writes.length, 0);
  assert.equal(h.catalog.get("refund_payment"), null);
});

test("a superseded proposal cannot be applied", async () => {
  const h = harness({ proposals: [proposalRow({ status: "superseded" })] });
  assert.deepEqual(await applyProposal(PROJECT, "p1", "u", h.deps), {
    ok: false,
    reason: "not_pending",
  });
});

test("an unknown proposal is reported as missing, not as a conflict", async () => {
  const h = harness();
  assert.deepEqual(await applyProposal(PROJECT, "nope", "u", h.deps), {
    ok: false,
    reason: "not_found",
  });
});

test("apply-all keeps the good edits and reports only the ones that failed", async () => {
  const h = harness({
    overrides: { refund_payment: null, list_invoices: null },
    proposals: [
      proposalRow({ id: "p1", entryId: "refund_payment" }),
      proposalRow({ id: "p2", entryId: "gone_away" }),
      proposalRow({ id: "p3", entryId: "list_invoices", proposedSearchable: "Lists invoices." }),
    ],
  });
  const outcome = await applyProposals(PROJECT, ["p1", "p2", "p3"], "user_1", h.deps);
  assert.deepEqual(outcome.applied, ["p1", "p3"]);
  assert.deepEqual(outcome.failed, [{ proposalId: "p2", reason: "entry_gone" }]);
  assert.equal(h.catalog.get("list_invoices"), "Lists invoices.");
});

test("a throwing write is reported per item rather than aborting the batch", async () => {
  const h = harness({
    overrides: { refund_payment: null, list_invoices: null },
    proposals: [
      proposalRow({ id: "p1", entryId: "refund_payment" }),
      proposalRow({ id: "p2", entryId: "list_invoices" }),
    ],
  });
  let calls = 0;
  const deps: ApplyDeps = {
    ...h.deps,
    swapOverride: async (projectId, entryId, value) => {
      calls += 1;
      if (calls === 1) throw new Error("connection reset");
      return h.deps.swapOverride(projectId, entryId, value);
    },
  };
  const outcome = await applyProposals(PROJECT, ["p1", "p2"], "user_1", deps);
  assert.deepEqual(outcome.applied, ["p2"]);
  assert.deepEqual(outcome.failed, [{ proposalId: "p1", reason: "error" }]);
});
