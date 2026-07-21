import { describe, expect, it } from "vitest";
import {
  type FactCandidate,
  factHash,
  groundingMarker,
  type LedgerEntry,
  planInjection,
  readGroundingLedger,
} from "./experimental.js";

const cand = (id: string, hash: string): FactCandidate => ({ id, hash });
const entry = (id: string, hash: string, distance: number): LedgerEntry => ({ id, hash, distance });

describe("planInjection", () => {
  it("injects an absent fact as `never` with no session history", () => {
    const [d] = planInjection({ candidates: [cand("a", "h1")], ledger: [] });
    expect(d).toEqual({ id: "a", inject: true, reason: "never" });
  });

  it("distinguishes `evicted` from `never` via everInjected", () => {
    const out = planInjection({
      candidates: [cand("seen", "h1"), cand("unseen", "h2")],
      ledger: [],
      everInjected: new Set(["seen"]),
    });
    expect(out).toEqual([
      { id: "seen", inject: true, reason: "evicted" },
      { id: "unseen", inject: true, reason: "never" },
    ]);
  });

  it("skips a present, unchanged fact as `fresh` (the token-saving case)", () => {
    const [d] = planInjection({
      candidates: [cand("a", "h1")],
      ledger: [entry("a", "h1", 3)],
    });
    expect(d).toEqual({ id: "a", inject: false, reason: "fresh" });
  });

  it("re-injects a present fact whose body changed as `mutated`", () => {
    const [d] = planInjection({
      candidates: [cand("a", "h2")],
      ledger: [entry("a", "h1", 1)],
    });
    expect(d).toEqual({ id: "a", inject: true, reason: "mutated" });
  });

  it("does not re-inject on distance alone by default (window = Infinity)", () => {
    const [d] = planInjection({
      candidates: [cand("a", "h1")],
      ledger: [entry("a", "h1", 9999)],
    });
    expect(d.inject).toBe(false);
    expect(d.reason).toBe("fresh");
  });

  it("re-injects as `stale` once distance exceeds an explicit freshness window", () => {
    const within = planInjection({
      candidates: [cand("a", "h1")],
      ledger: [entry("a", "h1", 10)],
      policy: { freshnessWindow: 10 },
    });
    expect(within[0].inject).toBe(false); // distance == window is still fresh

    const beyond = planInjection({
      candidates: [cand("a", "h1")],
      ledger: [entry("a", "h1", 11)],
      policy: { freshnessWindow: 10 },
    });
    expect(beyond[0]).toEqual({ id: "a", inject: true, reason: "stale" });
  });

  it("mutation wins over staleness when both hold", () => {
    const [d] = planInjection({
      candidates: [cand("a", "h2")],
      ledger: [entry("a", "h1", 100)],
      policy: { freshnessWindow: 10 },
    });
    expect(d.reason).toBe("mutated");
  });

  it("judges an id by its freshest (smallest-distance) marker", () => {
    // Re-injected fact: an old buried copy (h1@50) and a newer copy (h2@1).
    // The newer copy is current, so an h2 candidate is fresh, not mutated.
    const [d] = planInjection({
      candidates: [cand("a", "h2")],
      ledger: [entry("a", "h1", 50), entry("a", "h2", 1)],
    });
    expect(d).toEqual({ id: "a", inject: false, reason: "fresh" });
  });

  it("is order-preserving and deterministic across repeated calls", () => {
    const input = {
      candidates: [cand("a", "h1"), cand("b", "h2"), cand("c", "h3")],
      ledger: [entry("b", "h2", 2)],
    };
    const first = planInjection(input);
    const second = planInjection(input);
    expect(first.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(first).toEqual(second);
  });

  it("returns an empty plan for no candidates", () => {
    expect(planInjection({ candidates: [], ledger: [entry("a", "h1", 0)] })).toEqual([]);
  });
});

describe("factHash", () => {
  it("is stable for the same body", () => {
    expect(factHash("12 Baker Street")).toBe(factHash("12 Baker Street"));
  });

  it("changes when the body changes", () => {
    expect(factHash("Mon–Fri 9–6")).not.toBe(factHash("Mon–Sat 9–8"));
  });

  it("is a fixed-width lowercase-hex digest", () => {
    expect(factHash("anything")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("grounding marker codec", () => {
  it("round-trips a single injected fact with distance 0 at the end", () => {
    const h = factHash("12 Baker Street, London");
    const texts = ["earlier turn", `Shop address. ${groundingMarker("shop-address", h)}`];
    const ledger = readGroundingLedger(texts);
    expect(ledger).toEqual([{ id: "shop-address", hash: h, distance: 0 }]);
  });

  it("computes distance as messages from the end", () => {
    const texts = [`${groundingMarker("a", "aaaaaaaaaaaa")}`, "middle", "latest"];
    const [e] = readGroundingLedger(texts);
    expect(e).toEqual({ id: "a", hash: "aaaaaaaaaaaa", distance: 2 });
  });

  it("keeps the freshest occurrence when a fact was injected twice", () => {
    const texts = [
      `old ${groundingMarker("a", "111111111111")}`,
      "gap",
      `new ${groundingMarker("a", "222222222222")}`,
    ];
    const ledger = readGroundingLedger(texts);
    expect(ledger).toEqual([{ id: "a", hash: "222222222222", distance: 0 }]);
  });

  it("reads multiple markers within one message", () => {
    const line = `${groundingMarker("a", "aaaaaaaaaaaa")} and ${groundingMarker("b", "bbbbbbbbbbbb")}`;
    const ledger = readGroundingLedger([line]);
    expect(ledger.map((e) => e.id).sort()).toEqual(["a", "b"]);
    expect(ledger.every((e) => e.distance === 0)).toBe(true);
  });

  it("returns an empty ledger when no markers are present", () => {
    expect(readGroundingLedger(["hello", "world"])).toEqual([]);
  });

  it("ignores near-miss text that isn't a real marker", () => {
    expect(readGroundingLedger(["ratel:fact id=a v=zzz (not bracketed)"])).toEqual([]);
  });
});

describe("planInjection over a real transcript (end-to-end)", () => {
  const body = "Open Mon–Sat, 9am–7pm.";
  const h = factHash(body);
  const injected = `Hours. ${groundingMarker("hours", h)}`;

  it("skips a fact already present and fresh in the transcript", () => {
    const ledger = readGroundingLedger(["user asks something", injected]);
    const [d] = planInjection({ candidates: [cand("hours", h)], ledger });
    expect(d.inject).toBe(false);
  });

  it("re-injects after the body is edited (hash no longer matches the marker)", () => {
    const ledger = readGroundingLedger(["user asks something", injected]);
    const newHash = factHash("Open Mon–Sun, 8am–8pm.");
    const [d] = planInjection({ candidates: [cand("hours", newHash)], ledger });
    expect(d).toEqual({ id: "hours", inject: true, reason: "mutated" });
  });

  it("re-injects after compaction drops the marker (evicted)", () => {
    const ledger = readGroundingLedger(["summary of the conversation so far"]);
    const [d] = planInjection({
      candidates: [cand("hours", h)],
      ledger,
      everInjected: new Set(["hours"]),
    });
    expect(d).toEqual({ id: "hours", inject: true, reason: "evicted" });
  });
});
